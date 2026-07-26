#!/usr/bin/env node
'use strict';
const { program } = require('commander');
program.name('queuectl').description('CLI-based background job queue').version('1.0.0');
program.command('enqueue').description('Add a job to the queue').argument('<json>').action((json) => {
  require('../src/commands/enqueue').enqueueHandler(json);
});
const workerCmd = program.command('worker').description('Manage worker processes');
workerCmd.command('start').option('--count <n>', 'Workers', '1').action((opts) => {
  require('../src/commands/worker').workerStartHandler(opts);
});
workerCmd.command('stop').action(() => {
  require('../src/commands/worker').workerStopHandler();
});
program.command('status').action(() => require('../src/commands/status').statusHandler());
program.command('list').option('--state <state>').option('--json').action((opts) => require('../src/commands/list').listHandler(opts));
const dlqCmd = program.command('dlq');
dlqCmd.command('list').option('--json').action((opts) => require('../src/commands/dlq').dlqListHandler(opts));
dlqCmd.command('retry').argument('<id>').action((id) => require('../src/commands/dlq').dlqRetryHandler(id));
const configCmd = program.command('config');
configCmd.command('set').argument('<key>').argument('<value>').action((k, v) => require('../src/commands/config').configSetHandler(k, v));
program.command('dashboard').option('--port <p>', 'Port', '3000').action((opts) => {
  try {
    require('../src/commands/dashboard').dashboardHandler(opts);
  } catch (e) {
    require('../src/commands/dashboard')(opts);
  }
});
program.parse();
