import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { configSchema, type BoardConfig, type Identity, type AgentSession } from '@baton/shared';
import { readLocalAccess } from '@baton/shared/local';
import { BoardClient } from './api.js';

export const configPath = (path?: string) =>
  resolve(path ?? process.env.BOARD_CONFIG ?? resolve(homedir(), '.agent-board/agents.yaml'));
export async function readConfig(path?: string): Promise<BoardConfig> {
  return configSchema.parse(parse(await readFile(configPath(path), 'utf8')));
}

/** A shared MCP loads local access once. No participant identity is stored on this client. */
export async function localClient(options: { config?: string; url?: string } = {}) {
  const target = configPath(options.config);
  const config = await readConfig(target);
  return new BoardClient(
    options.url ?? process.env.BOARD_URL ?? config.url,
    await readLocalAccess(target),
  );
}

export async function clientFromOptions(options: {
  as?: string;
  config?: string;
  url?: string;
  session?: string;
  role?: string;
}): Promise<{ client: BoardClient; handle?: string; env: NodeJS.ProcessEnv; joined: boolean }> {
  const target = configPath(options.config);
  const config = await readConfig(target);
  if (options.as && process.env.BOARD_AGENT && process.env.BOARD_AGENT !== options.as)
    throw new Error('This session already has BOARD_AGENT set. Use its existing identity.');
  const url = options.url ?? process.env.BOARD_URL ?? config.url;
  const handle = options.as ?? process.env.BOARD_AGENT;
  const sessionId = options.session ?? process.env.BOARD_SESSION_ID;
  const env: NodeJS.ProcessEnv = { ...process.env, BOARD_CONFIG: target, BOARD_URL: url };
  delete env.BOARD_TOKEN;
  // Local humans are explicit CLI identities. Never fall back from a failed agent session.
  if (handle && config.humans[handle]) {
    if (sessionId || process.env.BOARD_AGENT)
      throw new Error('An agent session cannot switch to a local human identity.');
    return { client: new BoardClient(url, { human: handle }), handle, env, joined: false };
  }
  const base = new BoardClient(url, await readLocalAccess(target));
  if (sessionId) {
    const client = base.withSession(sessionId);
    const identity = await assertIdentity(client, handle);
    return {
      client,
      handle: identity.participant.handle,
      env: { ...env, BOARD_SESSION_ID: sessionId, BOARD_AGENT: identity.participant.handle },
      joined: false,
    };
  }
  if (!handle)
    throw new Error(
      'Use join to obtain a session ID, then pass --session <id>. For one command, --as <handle> joins and leaves automatically.',
    );
  const profile = config.agents[handle];
  const result = await base.call<AgentSession>('join', {
    handle,
    role: options.role ?? profile?.role,
  });
  const client = base.withSession(result.data.session_id);
  return {
    client,
    handle,
    env: { ...env, BOARD_AGENT: handle, BOARD_SESSION_ID: result.data.session_id },
    joined: true,
  };
}

export async function assertIdentity(client: BoardClient, handle?: string): Promise<Identity> {
  const identity = (await client.call<Identity>('whoami', {})).data;
  if (handle && identity.participant.handle !== handle)
    throw new Error(
      `Expected @${handle}, but this session belongs to @${identity.participant.handle}. Use the correct session ID before acting.`,
    );
  return identity;
}

export async function leaveSession(client: BoardClient): Promise<void> {
  await client.call('leave', {}, AbortSignal.timeout(3000));
}
