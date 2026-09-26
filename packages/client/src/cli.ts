#!/usr/bin/env node
import { Command } from 'commander';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inspect } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import notifier from 'node-notifier';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { operations, schemas, type BoardConfig, type Mention, type Operation } from '@baton/shared';
import { ensureLocalAccess, migrateConfig } from '@baton/shared/local';
import { ApiError } from './api.js';
import {
  assertIdentity,
  clientFromOptions,
  configPath,
  localClient,
  leaveSession,
} from './identity.js';

const program = new Command()
  .name('agent-board')
  .description('Baton: a local task board and inbox for independent agent sessions.')
  .version('0.1.0');
program
  .option('--as <handle>', 'Use a participant from the local config')
  .option('--session <id>', 'Baton session ID returned by join')
  .option('--role <role>', 'Role when joining a new agent handle')
  .option('--config <path>', 'Local agents.yaml')
  .option('--url <url>', 'Loopback board URL')
  .option('--json', 'Print machine-readable JSON');
type Options = {
  as?: string;
  config?: string;
  url?: string;
  session?: string;
  role?: string;
  json?: boolean;
  data?: string;
  dataFile?: string;
} & Record<string, unknown>;
const print = (data: unknown, options: Options) =>
  console.log(
    options.json
      ? JSON.stringify(data)
      : inspect(data, { depth: 8, colors: process.stdout.isTTY, compact: false }),
  );
const jsonValue = (value: string) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Invalid JSON argument: ${value.slice(0, 80)}`);
  }
};
const inputData = async (options: Options): Promise<Record<string, unknown>> => {
  if (options.data && options.dataFile) throw new Error('Use either --data or --data-file.');
  const raw = options.dataFile ? await readFile(options.dataFile, 'utf8') : options.data;
  const data: unknown = raw ? JSON.parse(raw) : {};
  if (!data || Array.isArray(data) || typeof data !== 'object')
    throw new Error('Command data must be a JSON object.');
  return data as Record<string, unknown>;
};
async function execute(operation: Operation, input: Record<string, unknown>, options: Options) {
  if (operation.startsWith('worker_')) {
    print(
      await (await localClient(options)).call(operation, schemas[operation].parse(input)),
      options,
    );
    return;
  }
  if (operation === 'join') {
    const client = await localClient(options);
    print(await client.call('join', schemas.join.parse(input)), options);
    return;
  }
  const { client, handle, joined } = await clientFromOptions(options);
  try {
    await assertIdentity(client, handle);
    print(await client.call(operation, schemas[operation].parse(input)), options);
  } finally {
    if (joined && operation !== 'leave') await cleanupSession(client);
  }
}
async function cleanupSession(client: import('./api.js').BoardClient) {
  try {
    await leaveSession(client);
  } catch (error) {
    console.error(
      `Baton session cleanup failed; activity will become stale after 90 seconds: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
const groups = new Map<string, Command>();
function group(name: string): Command {
  if (!groups.has(name)) groups.set(name, program.command(name));
  return groups.get(name)!;
}
const commands: Record<Operation, string> = {
  dispatch_task: 'task dispatch',
  complete_plan: 'task complete-plan',
  stop_worker: 'worker stop',
  worker_get_task: 'worker get',
  worker_post_message: 'worker message',
  worker_submit: 'worker submit',
  worker_review: 'worker review',
  worker_heartbeat: 'worker heartbeat',
  join: 'join',
  leave: 'leave',
  whoami: 'whoami',
  set_status: 'status',
  list_participants: 'participant list',
  freeze_participant: 'participant freeze',
  list_tasks: 'task list',
  get_task: 'task get',
  create_task: 'task create',
  claim_task: 'task claim',
  claim_next: 'task next',
  update_task: 'task update',
  release_task: 'task release',
  submit_for_review: 'task submit',
  review_task: 'task review',
  request_approval: 'task approval',
  transition_task: 'task transition',
  list_approvals: 'approvals list',
  reject_approval: 'approvals reject',
  post_message: 'message post',
  get_thread: 'message thread',
  list_channels: 'message channels',
  check_inbox: 'inbox',
  mark_read: 'inbox mark',
  wait_inbox: 'inbox wait',
  get_events: 'events',
  get_lock: 'lock show',
  acquire_lock: 'lock acquire',
  release_lock: 'lock release',
  get_settings: 'settings get',
  put_settings: 'settings set',
  get_overview: 'overview',
  list_decisions: 'message decisions',
};
type JsonProperty = { type?: string; anyOf?: { type?: string }[]; description?: string };
for (const operation of Object.keys(commands) as Operation[]) {
  const parts = commands[operation].split(' ');
  let command: Command;
  if (operation === 'check_inbox') command = group('inbox');
  else
    command = parts.length === 1 ? program.command(parts[0]!) : group(parts[0]!).command(parts[1]!);
  command
    .description(operations[operation].description)
    .option('--data <json>', 'Parameters as a JSON object')
    .option('--data-file <path>', 'Read parameters from a JSON file')
    .option('--json', 'Print JSON');
  const properties =
    (
      z.toJSONSchema(schemas[operation], { io: 'input' }) as {
        properties?: Record<string, JsonProperty>;
      }
    ).properties ?? {};
  if ('id' in properties) command.argument('<id>', 'Task, criterion, or approval ID', Number);
  for (const [name, spec] of Object.entries(properties)) {
    if (name === 'id') continue;
    const flag = name.replaceAll('_', '-');
    if (spec.type === 'boolean')
      command.option(`--${flag} [boolean]`, name, (value) =>
        value === 'true' ? true : value === 'false' ? false : value,
      );
    else
      command.option(`--${flag} <value>`, name, (value) => {
        if (spec.type === 'integer' || spec.type === 'number') return Number(value);
        if (spec.type === 'array' || spec.type === 'object') return jsonValue(value);
        return value;
      });
  }
  command.action(async (...args: unknown[]) => {
    const current = args.at(-1) as Command;
    const options = current.optsWithGlobals<Options>();
    const input = await inputData(options);
    if ('id' in properties) input.id = args[0];
    for (const name of Object.keys(properties)) {
      const camel = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      // Commander treats a parser result of null as a missing option value.
      if (options[camel] !== undefined)
        input[name] =
          options[camel] === 'null' && properties[name]?.anyOf?.some((s) => s.type === 'null')
            ? null
            : options[camel];
    }
    await execute(operation, input, options);
  });
}

program
  .command('call')
  .description('Call any MCP-equivalent operation by its exact tool name.')
  .argument('<operation>')
  .option('--data <json>')
  .option('--data-file <path>')
  .option('--json')
  .action(async (name: string, _opts, command: Command) => {
    if (!(name in operations))
      throw new Error(`Unknown operation ${name}. Use: ${Object.keys(operations).join(', ')}`);
    const options = command.optsWithGlobals<Options>();
    await execute(name as Operation, await inputData(options), options);
  });
program
  .command('approve')
  .description('Human approval shortcut.')
  .argument('<id>', 'Task ID', Number)
  .option('--to-status <status>', 'Approved target status', 'done')
  .requiredOption('--reason <text>')
  .option('--json')
  .action(async (id: number, _opts, command: Command) => {
    const options = command.optsWithGlobals<Options>();
    await execute(
      'transition_task',
      { id, status: options.toStatus, reason: options.reason },
      options,
    );
  });
program
  .command('init')
  .description('Create role presets and a local user. No human login is required.')
  .option('--human <handle>', 'Human handle', 'dax')
  .action(async (_opts, command: Command) => {
    const options = command.optsWithGlobals<Options>();
    const human = String(options.human);
    const config: BoardConfig = {
      url: options.url ?? 'http://127.0.0.1:4100',
      agents: {
        planner: { role: 'planner' },
        coder: { role: 'implementer' },
        tester: { role: 'tester' },
      },
      humans: {
        [human]: {
          display_name: human,
        },
      },
    };
    const { configSchema } = await import('@baton/shared');
    configSchema.parse(config);
    const target = configPath(options.config);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, stringify(config), { flag: 'wx', mode: 0o600 });
    await chmod(target, 0o600);
    await ensureLocalAccess(target);
    print(
      {
        config: target,
        human,
        message: 'Start Baton and open the dashboard. It uses this local user without a login.',
      },
      options,
    );
  });
program
  .command('migrate')
  .description('Remove obsolete credentials, runtime and model fields from the config.')
  .action(async (_opts, command: Command) => {
    const options = command.optsWithGlobals<Options>();
    const target = configPath(options.config);
    const config = migrateConfig(parse(await readFile(target, 'utf8')));
    await writeFile(target, stringify(config), { mode: 0o600 });
    await chmod(target, 0o600);
    await ensureLocalAccess(target);
    print(
      {
        config: target,
        message:
          'Migrated. Restart Baton. The dashboard needs no login; agents join to get a session ID.',
      },
      options,
    );
  });
program
  .command('run')
  .description(
    'Optionally run a command in one Baton session, with exit cleanup. Use -- before the child command.',
  )
  .argument('<command...>')
  .action(async (commandArgs: string[], _opts, command: Command) => {
    const options = command.optsWithGlobals<Options>();
    if (!options.as) throw new Error('run requires --as <handle>.');
    const { client, env, handle, joined } = await clientFromOptions(options);
    const identity = await assertIdentity(client, handle);
    if (identity.participant.kind !== 'agent') throw new Error('run requires an agent identity.');
    const child = spawn(commandArgs[0]!, commandArgs.slice(1), {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const onSignal = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    const interrupt = () => onSignal('SIGINT');
    const terminate = () => onSignal('SIGTERM');
    const hangup = () => onSignal('SIGHUP');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    process.on('SIGHUP', hangup);
    try {
      process.exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          resolve(
            code ??
              (signal === 'SIGINT'
                ? 130
                : signal === 'SIGHUP'
                  ? 129
                  : signal === 'SIGTERM'
                    ? 143
                    : 1),
          ),
        );
      });
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      process.off('SIGHUP', hangup);
      if (joined) await cleanupSession(client);
    }
  });
program
  .command('watch')
  .description(
    'Print new mentions as JSON lines; optional desktop notifications. Does not launch or wake agent sessions.',
  )
  .option('--notify', 'Send a desktop notification for each new mention')
  .option('--since <id>', 'Resume from a mention ID', Number, 0)
  .action(async (_opts, command: Command) => {
    const options = command.optsWithGlobals<Options>();
    const { client, handle, joined } = await clientFromOptions(options);
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    let cursor = Number(options.since);
    let retryMs = 1000;
    let verified = false;
    try {
      while (!abort.signal.aborted) {
        try {
          if (!verified) {
            await assertIdentity(client, handle);
            verified = true;
          }
          const result = await client.call<Mention[]>(
            'wait_inbox',
            { since: cursor, timeout: 55 },
            abort.signal,
          );
          retryMs = 1000;
          for (const mention of result.data) {
            console.log(JSON.stringify(mention));
            cursor = mention.id;
            if (options.notify)
              await new Promise<void>((resolve) =>
                notifier.notify(
                  {
                    title: `Baton · @${mention.message.author}`,
                    message: mention.message.body.slice(0, 240),
                    wait: false,
                  },
                  (error) => {
                    if (error) console.error(`Desktop notification failed: ${error.message}`);
                    resolve();
                  },
                ),
              );
          }
        } catch (error) {
          if (abort.signal.aborted) break;
          if (error instanceof ApiError && error.status < 500 && ![408, 429].includes(error.status))
            throw error;
          if (
            !(error instanceof ApiError) &&
            !(error instanceof TypeError) &&
            !(error instanceof DOMException && error.name === 'TimeoutError')
          )
            throw error;
          console.error(
            `Baton watch disconnected; retrying in ${retryMs / 1000}s from mention ${cursor}: ${error instanceof Error ? error.message : String(error)}`,
          );
          verified = false;
          await delay(retryMs, undefined, { signal: abort.signal });
          retryMs = Math.min(retryMs * 2, 30000);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('SIGHUP', stop);
      if (joined) await cleanupSession(client);
    }
  });

program.parseAsync().catch((error) => {
  const message =
    error instanceof ApiError
      ? { code: error.code, message: error.message, next: error.next }
      : { code: 'client_error', message: error instanceof Error ? error.message : String(error) };
  console.error(
    program.opts().json || process.argv.includes('--json')
      ? JSON.stringify({ error: message })
      : Object.values(message).join('\n'),
  );
  process.exitCode = 1;
});
