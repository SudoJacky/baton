#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { operations, schemas, type Operation } from '@baton/shared';
import { ApiError } from './api.js';
import { localClient } from './identity.js';

async function main() {
  const { values } = parseArgs({
    options: { config: { type: 'string' }, url: { type: 'string' } },
  });
  const client = await localClient(values);
  const server = new McpServer(
    { name: 'agent-board', version: '0.1.0' },
    {
      instructions:
        "Baton is a local shared task board. Call join once per conversation and keep the returned session_id. Every later tool call must include that conversation's ID. Resume with whoami using the existing ID. IDs identify cooperative sessions, not security principals. Never use another conversation's ID. Human approvals require the separate dashboard. Call leave only when ending the collaboration session. Activity reflects requests, not whether this MCP process is alive.",
    },
  );
  for (const name of Object.keys(operations) as Operation[]) {
    const route = operations[name];
    if (route.human) continue;
    const inputSchema =
      name === 'join' ? schemas.join : schemas[name].safeExtend({ session_id: z.string().uuid() });
    server.registerTool(
      name,
      {
        description: route.description,
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
          const scoped =
            name === 'join' ? client : client.withSession(z.string().uuid().parse(session_id));
          const result = await scoped.call(name, schemas[name].parse(params));
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (error) {
          const message =
            error instanceof ApiError
              ? `${error.code}: ${error.message} Next: ${error.next}`
              : error instanceof Error
                ? error.message
                : String(error);
          return { content: [{ type: 'text', text: message }], isError: true };
        }
      },
    );
  }
  // A host may share or restart this process. Logical sessions end only on explicit leave.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
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
