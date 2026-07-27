# queuectl

A CLI-based background job queue with atomic job claiming, crash recovery, and retry/dead-letter-queue semantics.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    queuectl CLI                         │
│  enqueue │ worker start/stop │ status │ list │ dlq │ config  │
└────────────┬──────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────┐
│                   SQLite (WAL mode)                     │
│  ┌──────────┐  ┌──────────┐                             │
│  │  jobs    │  │  config  │                             │
│  └──────────┘  └──────────┘                             │
└──────────┬──────────────────────────────────────────────┘
           │ read/write (file-level locking)
           ▼
┌──────────────────────────────────────────────────────────┐
│                    Supervisor                            │
│  Forks N worker child processes                         │
│  Forwards SIGTERM/SIGINT → IPC shutdown                 │
│  Writes PID files to workers/                           │
│                                                         │
│  ┌────────┐  ┌────────┐  ┌────────┐                     │
│  │Worker 1│  │Worker 2│  │Worker N│                     │
│  │        │  │        │  │        │                     │
│  │ Claim  │  │ Claim  │  │ Claim  │  (atomic UPDATE)    │
│  │ Execute│  │ Execute│  │ Execute│  (child_process)    │
│  │ Heartbeat│ │ Heartbeat│ │ Heartbeat│ (every 5s)      │
│  │ Reaper │  │ Reaper │  │ Reaper │  (every iteration) │
│  └────────┘  └────────┘  └────────┘                     │
└──────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Atomic claiming**: A single `UPDATE ... WHERE state='pending'` with a subquery. SQLite serializes writers at the file level, so two workers racing on the same job get exactly one `changes=1` and one `changes=0`. No application-level locking needed.
- **Crash recovery**: Each worker runs a reaper sweep every loop iteration, reclaiming jobs stuck in `processing` past a 20s lease timeout. Worst-case recovery: ≤30s.
- **Config snapshot**: `max_retries` and `backoff_base` are snapshotted onto jobs at creation time. Changing global config only affects future jobs.

See [DECISIONS.md](DECISIONS.md) for detailed design rationale.

## Prerequisites

- **OS**: Linux (tested on Ubuntu/WSL2)
- **Node.js**: v22+
- **Build tools** (for `better-sqlite3` native module):
  ```bash
  sudo apt update && sudo apt install -y build-essential python3
  ```

## Setup

**Important Note:** This project was developed and tested on WSL2/Linux. POSIX signal handling (used for graceful shutdown via \`worker stop\`) requires a Unix-like environment and will not work correctly on native Windows.

```bash
git clone <repo-url> && cd queuectl
npm install
```

To make `queuectl` available globally (optional):
```bash
npm link
```

## Usage

### Enqueue a Job

```bash
# Basic job
node bin/queuectl.js enqueue '{"id":"job1","command":"echo Hello World"}'

# With custom retry settings
node bin/queuectl.js enqueue '{"id":"job2","command":"curl https://example.com","max_retries":5,"backoff_base":3}'
```

### Start Workers

```bash
# Start 3 workers (foreground, blocks until stopped)
node bin/queuectl.js worker start --count 3
```

Workers shut down gracefully on `SIGTERM` or `SIGINT` (Ctrl+C) — they finish the current job before exiting.

### Stop Workers (from another terminal)

```bash
node bin/queuectl.js worker stop
```

### Check Status

```bash
$ node bin/queuectl.js status
=== Job Queue Status ===
  Pending:    0
  Processing: 0
  Completed:  1
  Failed:     0
  Dead (DLQ): 0

  Active workers: 0
```

### List Jobs

```bash
# Human-readable
$ node bin/queuectl.js list --state pending

ID                   STATE        ATTEMPTS   COMMAND                        CREATED
------------------------------------------------------------------------------------------
job1                 pending      0          echo Hello World               2026-07-28T09:00:00.000Z

# Machine-readable JSON (used by automated tests)
$ node bin/queuectl.js list --state completed --json
[{"id":"job1","command":"echo Hello World","state":"completed","attempts":0,"max_retries":3,"backoff_base":2,"created_at":"...","updated_at":"...","claimed_at":null,"heartbeat_at":null,"worker_id":null,"next_retry_at":"...","last_error":null}]
```

### Dead Letter Queue

```bash
# List dead jobs
node bin/queuectl.js dlq list

# Retry a dead job (resets attempts to 0)
node bin/queuectl.js dlq retry job1
```

### Configuration

```bash
# Set global defaults (only affects future jobs)
node bin/queuectl.js config set max-retries 5
node bin/queuectl.js config set backoff-base 3
```

## Job Lifecycle

```
pending → processing → completed
                    ↘ failed → processing (after backoff)
                                  ↘ ... → dead (DLQ, after max_retries)
```

- **pending**: Waiting to be claimed by a worker
- **processing**: Claimed by a worker, currently executing
- **completed**: Finished successfully (exit code 0)
- **failed**: Execution failed, will retry after backoff delay
- **dead**: All retries exhausted, moved to dead letter queue

## Retry & Backoff

- Delay: `backoff_base ^ attempts` seconds (exponential)
- Default: base=2, max_retries=3 → delays of 2s, 4s, 8s
- After `max_retries` failures → moves to `dead` (DLQ)
- `dlq retry` resets attempts to 0 (fresh start)

## Running Tests

\`\`\`bash
node scripts/verify.js
\`\`\`

This runs 5 automated scenarios in sequence, verifying all core constraints:
1. **Basic job completes**: A simple echo job is enqueued, processed, and moves to `completed`.
2. **Failing job retries with backoff → DLQ**: A failing job correctly increments attempts, waits for backoff, and eventually lands in `dead`.
3. **Concurrency Exactly Once**: 10 jobs processed across 3 workers concurrently finish with 0 duplicates.
4. **SIGKILL Recovery**: A worker is hard-killed mid-execution. The reaper claims it after the 20s lease timeout and it successfully recovers.
5. **Process Restart**: Jobs survive a full process restart without data loss.

*Note: Tests wipe the local `data/` and `workers/` directories for isolation.*

## Demo Recording
🎥 **[Watch the end-to-end demo recording here](https://example.com/queuectl-demo)** (Demonstrates usage, concurrency, and crash recovery).

## Web Dashboard (Bonus)

A real-time monitoring dashboard is included as a bonus feature.

```bash
node bin/queuectl.js dashboard          # starts on http://localhost:3000
node bin/queuectl.js dashboard --port 8080  # custom port
```

The dashboard polls the SQLite database every 2 seconds and displays live job state counts and active worker PIDs. It uses Express.js for the API and vanilla HTML/CSS/JS for the frontend.

## Project Structure

```
queuectl/
├── bin/queuectl.js           # CLI entry point (commander)
├── public/
│   └── index.html            # Dashboard frontend (vanilla HTML/CSS/JS)
├── src/
│   ├── db.js                 # SQLite connection + schema
│   ├── models/
│   │   ├── job.js            # Job CRUD
│   │   └── config.js         # Config get/set
│   ├── worker/
│   │   ├── supervisor.js     # Forks N workers, manages lifecycle
│   │   ├── loop.js           # Claim loop + reaper + heartbeat
│   │   └── registry.js       # PID file management
│   └── commands/
│       ├── enqueue.js        # enqueue handler
│       ├── worker.js         # worker start/stop handlers
│       ├── status.js         # status handler
│       ├── list.js           # list handler
│       ├── dlq.js            # dlq list/retry handlers
│       ├── config.js         # config set handler
│       └── dashboard.js      # dashboard server handler
├── scripts/verify.js         # Self-test script
├── DECISIONS.md              # Design decision rationale
└── README.md                 # This file
```
