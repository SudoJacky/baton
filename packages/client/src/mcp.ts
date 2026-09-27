#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { operations, schemas, type Operation, type WorkerAssignment } from '@baton/shared';
import { ApiError } from './api.js';
import { localClient } from './identity.js';
import { WorkerLeases } from './worker-leases.js';
import { diagnose, withIntegration } from './integration.js';
import type { Envelope } from '@baton/shared';

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      url: { type: 'string' },
      profile: { type: 'string', default: 'workflow' },
    },
  });
  const profile = z.enum(['workflow', 'full']).parse(values.profile);
  const client = await localClient(values);
  const leases = new WorkerLeases(client);
  const server = new McpServer(
    { name: 'agent-board', version: '0.1.0' },
    {
      instructions:
        "Baton coordinates a planner and task-bound workers through one shared MCP. Planner: join once, create a draft plan and all its child tasks, request_approval(open), then dispatch_task after Dashboard approval. Dispatch prepares the worker but DOES NOT launch a model: use the host's subagent tools. Pass only run_id and context to the child. Worker: use get_task, post_message, submit, review with run_id; do not join, claim, manage leases or request approval. This MCP renews active worker leases until completion, stop_worker or disconnection. Stop assignments after confirming crashed/cancelled workers have stopped. Shared-directory work is serial; the repository lock spans review. Use complete_plan when all children finish. A stopped host does not launch or wake models.",
    },
  );
  const workflow = new Set<Operation>([
    'join',
    'whoami',
    'leave',
    'get_settings',
    'list_tasks',
    'create_task',
    'request_approval',
    'dispatch_task',
    'stop_worker',
    'complete_plan',
    'get_task',
    'post_message',
  ]);
  const present = (result: Envelope): CallToolResult => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(withIntegration(result, values.config, client, leases)),
      },
    ],
  });
  const failed = (error: unknown): CallToolResult => ({
    content: [
      {
        type: 'text',
        text:
          error instanceof ApiError
            ? `${error.code}: ${error.message} Next: ${error.next}`
            : error instanceof Error
              ? error.message
              : String(error),
      },
    ],
    isError: true,
  });
  const track = (result: { data: unknown }) => {
    if (
      result.data &&
      typeof result.data === 'object' &&
      'run_id' in result.data &&
      'heartbeat_after_ms' in result.data
    )
      leases.track(result.data as WorkerAssignment);
  };
  server.registerTool(
    'doctor',
    {
      description:
        'Integration self-check: inspect connection, identity, task repository and lease management. Does not join or start workers.',
      inputSchema: z
        .object({ run_id: z.string().uuid().optional(), session_id: z.string().uuid().optional() })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return present({ data: await diagnose(client, input, leases) });
      } catch (error) {
        return failed(error);
      }
    },
  );
  for (const name of Object.keys(operations) as Operation[]) {
    const route = operations[name];
    if (
      route.human ||
      name.startsWith('worker_') ||
      (profile === 'workflow' && !workflow.has(name))
    )
      continue;
    const inputSchema =
      name === 'join'
        ? schemas.join
        : name === 'get_task'
          ? z
              .object({
                run_id: z.string().uuid().optional(),
                session_id: z.string().uuid().optional(),
                id: z.number().int().positive().optional(),
                include_thread: z.boolean().optional(),
              })
              .strict()
          : name === 'post_message'
            ? z
                .object({
                  ...schemas.post_message.shape,
                  session_id: z.string().uuid().optional(),
                  run_id: z.string().uuid().optional(),
                  escalation: z.literal('merge_conflict').optional(),
                })
                .strict()
            : schemas[name].safeExtend({ session_id: z.string().uuid() });
    server.registerTool(
      name,
      {
        description: ['get_task', 'post_message'].includes(name)
          ? `${route.description} Workers pass run_id only for identity and task scope; planners pass session_id and normal parameters.`
          : route.description,
        inputSchema,
        annotations: {
          readOnlyHint: route.method === 'GET',
          destructiveHint: name === 'leave',
          openWorldHint: false,
        },
      },
      async (input: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const { session_id, ...params } = input;
          const run_id = params.run_id;
          if (run_id !== undefined && ['get_task', 'post_message'].includes(name)) {
            if (session_id !== undefined)
              throw new Error('Use run_id for a worker or session_id for a planner, not both.');
            const operation = name === 'get_task' ? 'worker_get_task' : 'worker_post_message';
            if (
              name === 'post_message' &&
              (params.task_id !== undefined ||
                params.channel !== undefined ||
                params.to !== undefined ||
                params.reply_to !== undefined ||
                (params.mentions as unknown[])?.length)
            )
              throw new Error(
                'Worker messages are bound to the assigned task; omit destinations, mentions and reply_to.',
              );
            const workerInput =
              name === 'get_task'
                ? params
                : { run_id, body: params.body, kind: params.kind, escalation: params.escalation };
            const result = await client.call(operation, schemas[operation].parse(workerInput));
            track(result);
            return present(result);
          }
          const scoped =
            name === 'join' ? client : client.withSession(z.string().uuid().parse(session_id));
          const result = await scoped.call(name, schemas[name].parse(params));
          track(result);
          return present(result);
        } catch (error) {
          return failed(error);
        }
      },
    );
  }
  for (const [name, operation] of [
    ['prepare_evidence', 'worker_prepare_evidence'],
    ['submit', 'worker_submit'],
    ['review', 'worker_review'],
  ] as const)
    server.registerTool(
      name,
      {
        description: operations[operation].description,
        inputSchema: schemas[operation],
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async (input: Record<string, unknown>) => {
        try {
          const result = await client.call(operation, schemas[operation].parse(input));
          track(result);
          return present(result);
        } catch (error) {
          return failed(error);
        }
      },
    );
  // A host may share or restart this process. Logical sessions end only on explicit leave.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    leases.close();
    await server.close();
    process.stdin.pause();
  };
  server.server.onclose = () => {
    void shutdown();
  };
  process.stdin.once('end', () => {
    void shutdown();
  });
  process.stdin.once('close', () => {
    void shutdown();
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(signal, () => {
      void shutdown();
    });
  await server.connect(new StdioServerTransport());
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
