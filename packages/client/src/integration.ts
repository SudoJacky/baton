import { fileURLToPath } from 'node:url';
import type { Envelope, Identity, WorkerAssignment } from '@baton/shared';
import type { BoardClient } from './api.js';
import { configPath } from './identity.js';
import type { WorkerLeases } from './worker-leases.js';

export function workerCommand(runId: string, config: string | undefined, url: string) {
  const argv = [
    process.execPath,
    fileURLToPath(new URL('./cli.js', import.meta.url)),
    '--config',
    configPath(config),
    '--url',
    url,
    'worker',
    'get',
    '--run-id',
    runId,
    '--json',
  ];
  const quote = (arg: string) =>
    process.platform === 'win32'
      ? `'${arg.replaceAll("'", "''")}'`
      : `'${arg.replaceAll("'", "'\\''")}'`;
  return {
    argv,
    shell: process.platform === 'win32' ? 'powershell' : 'sh',
    command: `${process.platform === 'win32' ? '& ' : ''}${argv.map(quote).join(' ')}`,
  };
}

export function withIntegration(
  result: Envelope,
  config: string | undefined,
  client: BoardClient,
  leases?: WorkerLeases,
): Envelope {
  const data = result.data as Partial<WorkerAssignment> | null;
  if (!data || typeof data !== 'object' || !data.run_id || !('heartbeat_after_ms' in data))
    return result;
  return {
    ...result,
    data: {
      ...data,
      integration: {
        transport: leases ? 'mcp' : 'cli',
        lease: leases ? leases.status(data.run_id) : { managed_here: false, last_success_at: null },
        lease_note: leases
          ? 'MCP manages the assignment lease while connected; model liveness is unknown.'
          : 'This CLI invocation does not renew leases. Keep a managing MCP connected or have the host call worker heartbeat.',
        worker_get: workerCommand(data.run_id, config, client.url),
      },
    },
  };
}

/** Inspect only: a check never joins, launches or starts renewing a worker. */
export async function diagnose(
  client: BoardClient,
  input: { run_id?: string; session_id?: string },
  leases?: WorkerLeases,
) {
  if (input.run_id && input.session_id) throw new Error('Use run_id or session_id, not both.');
  const checks: { name: string; status: 'ok' | 'attention' | 'unknown'; detail: unknown }[] = [];
  try {
    const response = await fetch(`${client.url}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || ((await response.json()) as { status?: string }).status !== 'ok')
      throw new Error(`Unexpected health response: HTTP ${response.status}.`);
    checks.push({
      name: 'connection',
      status: 'ok',
      detail: { url: client.url, transport: leases ? 'mcp' : 'cli' },
    });
    if (input.run_id) {
      const run = (await client.call<WorkerAssignment>('worker_get_task', { run_id: input.run_id }))
        .data;
      checks.push({
        name: 'identity',
        status: 'ok',
        detail: { handle: run.handle, run_id: run.run_id, task_id: run.task.id },
      });
      checks.push({
        name: 'repository',
        status: run.task.writes_code && !run.task.repository ? 'attention' : 'ok',
        detail: run.task.repository,
      });
      const lease = leases?.status(run.run_id) ?? { managed_here: false, last_success_at: null };
      checks.push({
        name: 'lease',
        status:
          run.state !== 'active' ||
          (lease.managed_here && !('last_error' in lease && lease.last_error))
            ? 'ok'
            : 'attention',
        detail: {
          ...lease,
          run_state: run.state,
          note: 'This checks management by this connection only. Model execution remains unknown.',
        },
      });
      checks.push({
        name: 'task',
        status: run.handoff.blockers.length ? 'attention' : 'ok',
        detail: run.handoff.blockers,
      });
      return { ready: checks.every((c) => c.status === 'ok'), checks, handoff: run.handoff };
    }
    if (input.session_id) {
      const identity = (await client.withSession(input.session_id).call<Identity>('whoami', {}))
        .data;
      checks.push({
        name: 'identity',
        status: identity.participant.frozen ? 'attention' : 'ok',
        detail: identity.participant.handle,
      });
      checks.push({
        name: 'repository',
        status: 'ok',
        detail: 'Repositories are bound per task; no server-wide repository.',
      });
      return {
        ready: checks.every((c) => c.status === 'ok'),
        checks,
        pending: identity.pending ?? [],
      };
    }
    checks.push({
      name: 'identity',
      status: 'unknown',
      detail: 'Provide run_id or session_id to verify access, identity and task context.',
    });
    return { ready: false, checks };
  } catch (error) {
    checks.push({
      name: 'request',
      status: 'attention',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ready: false, checks };
  }
}
