# Design Decisions

## 1. Which exact line(s) prevent two workers from claiming the same job, and why is that atomic across separate OS processes?

**File:** `src/worker/loop.js`, the `claimStmt` prepared statement (lines ~60-70).

```js
const claimStmt = db.prepare(`
  UPDATE jobs
  SET state = 'processing', worker_id = ?, claimed_at = ?, heartbeat_at = ?
  WHERE id = (
    SELECT id FROM jobs
    WHERE state IN ('pending', 'failed') AND next_retry_at <= ?
    ORDER BY created_at
    LIMIT 1
  )
  AND state IN ('pending', 'failed')
`);
```

And the check immediately after:

```js
const result = claimStmt.run(workerId, now, now, now);
if (result.changes === 0) { /* nothing to claim, poll again */ }
```

**Why this is atomic across separate OS processes:**

SQLite uses **file-level locking** to serialize all write operations. When two worker processes (separate `node` processes) execute this UPDATE concurrently:

1. Worker A acquires the write lock, executes the UPDATE. The subquery finds a pending job and updates it to `processing`. `result.changes === 1`.
2. Worker B tries to acquire the write lock, **blocks** until Worker A's transaction commits.
3. Worker B then executes the same UPDATE. The subquery finds the same job ID, but the outer `AND state IN ('pending', 'failed')` check now fails (Worker A already changed it to `processing`). `result.changes === 0`.

This is not relying on Node's single-threadedness — that doesn't matter because workers are **separate OS processes**. The guarantee comes entirely from SQLite's file-level write serialization.

**WAL mode** (set in `src/db.js`) allows concurrent readers while a writer holds the lock, which reduces contention but does not change the write serialization guarantee.

**`busy_timeout = 5000`** (set in `src/db.js`) means if Worker B tries to write while Worker A holds the lock, it retries for up to 5 seconds instead of immediately failing with `SQLITE_BUSY`.

---

## 2. What happens when a worker is SIGKILLed mid-job? Walk through step-by-step, including worst-case recovery delay.

**Step-by-step:**

1. Worker is executing a job. The job's state is `processing`, and `heartbeat_at` is being updated every 5 seconds by `setInterval` in `executeJob()` (`src/worker/loop.js`).

2. The worker receives SIGKILL. This is **untrappable** — Node cannot intercept it. The process dies immediately. The `setInterval` stops. `heartbeat_at` freezes at its last value.

3. The job is now stuck in `processing` with a stale `heartbeat_at`. No signal handler ran, no cleanup happened. The PID file in `workers/` is orphaned.

4. Another worker (either already running, or restarted manually) runs its claim loop. At the **top of every iteration**, it executes the reaper sweep (`src/worker/loop.js`, `reaperStmt`):

   ```js
   const cutoff = new Date(Date.now() - LEASE_TIMEOUT_S * 1000).toISOString();
   reaperStmt.run(now, cutoff);
   ```

   This finds all jobs where `state = 'processing'` AND `heartbeat_at < cutoff` (cutoff = now minus 20s), and resets them to `pending`.

5. The stuck job's `heartbeat_at` is now older than the cutoff → the reaper resets it to `pending`. It becomes eligible for claiming on the next iteration.

**Worst-case recovery delay:**

| Component | Delay | Explanation |
|-----------|-------|-------------|
| Stale heartbeat | 5s | The last heartbeat could have been up to 5s before the SIGKILL |
| Lease timeout | 20s | The reaper waits 20s after the last heartbeat before reclaiming |
| Poll interval | 5s | The reaper runs once per claim-loop iteration (every 5s) |
| **Total** | **30s** | Well under the 60s requirement |

**Constants** (all in `src/worker/loop.js`):
- `HEARTBEAT_INTERVAL_MS = 5000`
- `LEASE_TIMEOUT_S = 20`
- `POLL_INTERVAL_MS = 5000`

---

## 3. Does `dlq retry` reset `attempts`? Why?

**Yes.** `dlq retry` resets `attempts` to 0. See `src/commands/dlq.js`, `dlqRetryHandler()`:

```js
db.prepare(`
  UPDATE jobs
  SET state = 'pending', attempts = 0, updated_at = ?, next_retry_at = ?,
      last_error = NULL, worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
  WHERE id = ?
`).run(now, now, id);
```

**Rationale:** A DLQ retry is a **human-initiated action**. An operator looked at the dead job, diagnosed the issue (maybe the downstream service was down, or a bug was fixed), and explicitly chose to re-run it. This is semantically a "fresh start," not a continuation of the previous execution history.

**Trade-off acknowledged:** This means `max_retries` no longer bounds the *lifetime* attempt count — only the attempts since the last manual retry. A job could theoretically cycle through the DLQ indefinitely if an operator keeps retrying it. This is acceptable because:

1. Each DLQ retry requires a conscious human decision (`dlq retry <id>`).
2. The alternative (preserving attempts) would make DLQ retry fail immediately if the job already exhausted its retries, which defeats the purpose of having a retry command.
3. If lifetime attempt tracking is needed, the `last_error` field and the job's history provide an audit trail.

---

## 4. What designs did you consider and reject for `worker stop` cross-process signaling?

### Design considered: Database heartbeat/flag row

**Approach:** Write a `shutdown_requested` flag to the database. Workers poll this flag each loop iteration and exit when they see it.

**Rejected because:**
- Adds latency proportional to the poll interval (up to 5s before a worker notices).
- Mixes control flow with data storage — the database should store job state, not process lifecycle commands.
- Requires cleanup logic to clear the flag after shutdown, adding another failure mode.

### Design considered: Unix domain socket / TCP listener

**Approach:** Each worker listens on a socket. `worker stop` connects and sends a shutdown command.

**Rejected because:**
- Significantly more complex: need socket lifecycle management, port/path allocation, error handling for refused connections.
- Workers are child processes of the supervisor — they already have IPC channels. Adding sockets is redundant complexity.
- Socket files/ports can leak if workers crash, requiring cleanup.

### Design considered: Lock files with fs.watch

**Approach:** Create a `.stop` file in a directory and use `fs.watch` to detect changes.

**Rejected because:**
- Cross-platform `fs.watch` reliability is notoriously bad and failure-prone (though this is targeted at Linux, it's still brittle compared to signals).
- Requires a separate background thread or event loop watcher just for file polling.

### Design chosen: PID files + POSIX SIGTERM

**Implementation:** `src/commands/worker.js`, `workerStopHandler()` + `src/worker/registry.js`.

`worker stop` reads PID files from `workers/`, calls `process.kill(pid, 'SIGTERM')` for each live PID. Each worker has a SIGTERM handler (registered once at startup in `src/worker/loop.js`) that sets `shuttingDown = true`. The claim loop checks this flag and exits after finishing the current job.

**Why this won:**
- **Zero latency**: SIGTERM is delivered by the kernel immediately. No polling delay.
- **Works cross-terminal**: SIGTERM is not tied to the terminal session. `worker stop` from Terminal B correctly signals workers in Terminal A.
- **Simple to explain**: "SIGTERM handler sets a flag. The loop checks the flag." One sentence.
- **Standard Unix pattern**: Every production process manager (systemd, Docker, Kubernetes) uses SIGTERM for graceful shutdown. This isn't novel — it's the expected approach.

**Within the supervisor:** The supervisor uses **IPC messages** (not signals) to tell its child workers to shut down, because `child_process.fork()` already provides an IPC channel. The supervisor's own SIGTERM handler sends `{ type: 'shutdown' }` to all children. This means both `Ctrl+C` (SIGINT to the supervisor) and `worker stop` (SIGTERM to the supervisor) trigger the same graceful shutdown path.

---

## 5. If priorities were added tomorrow, what survives unchanged vs. breaks?

### Survives unchanged

- **Schema migration pattern** (`src/db.js`): Just add a `priority` column with `ALTER TABLE` or a new migration.
- **Worker lifecycle**: supervisor, PID files, SIGTERM handlers, heartbeat, reaper — none of these care about job priority.
- **Retry/backoff/DLQ logic**: The failure handling path doesn't depend on claim ordering.
- **All commands except the claim query**: `enqueue`, `status`, `list`, `dlq`, `config` need minimal or zero changes.

### Breaks / needs modification

1. **Claim query** (`src/worker/loop.js`, `claimStmt`): Currently orders by `created_at` (FIFO). Would need to change to `ORDER BY priority DESC, created_at` (highest priority first, FIFO within same priority).

2. **Index** (`src/db.js`, `idx_jobs_claim`): Currently on `(state, next_retry_at, created_at)`. Would need to include `priority`: `(state, next_retry_at, priority DESC, created_at)`.

3. **Enqueue command** (`src/commands/enqueue.js`): Would need to accept a `priority` field in the JSON input, with a sensible default (e.g., 0 = normal).

4. **List command** (`src/commands/list.js`): Would want to display priority and potentially sort by it.

**Effort estimate:** ~30 minutes. The architecture is inherently priority-agnostic — priority only affects *which* job gets claimed next, and that's a single `ORDER BY` clause. Everything downstream (execution, heartbeat, retry, reaper) treats all jobs identically.
