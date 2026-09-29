/** Node-only local access. Never export this module from the browser entry point. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { configSchema, type BoardConfig } from './index.js';

const accessSchema = z.object({ token: z.string().min(32) }).strict();
export const accessPath = (configFile: string) => `${configFile}.access.json`;

export function defaultConfig(human = 'dax', url = 'http://127.0.0.1:4100'): BoardConfig {
  return configSchema.parse({
    url,
    agents: {
      planner: { role: 'planner' },
      coder: { role: 'implementer' },
      tester: { role: 'tester' },
    },
    humans: { [human]: {} },
  });
}

export async function readLocalAccess(configFile: string): Promise<string> {
  try {
    return accessSchema.parse(JSON.parse(await readFile(accessPath(configFile), 'utf8'))).token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        `Baton local access is not initialized. Start the server with --config ${configFile}.`,
      );
    throw new Error(
      'Cannot read Baton local access. Check the access file and its permissions; it has not been rotated.',
      { cause: error },
    );
  }
}

export async function ensureLocalAccess(configFile: string): Promise<string> {
  const target = accessPath(configFile);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      target,
      JSON.stringify({ token: randomBytes(32).toString('base64url') }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readLocalAccess(configFile);
}

/** Remove obsolete participant credentials; local agent access is managed separately. */
export function migrateConfig(input: unknown): BoardConfig {
  const raw = z
    .object({
      agents: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      humans: z.record(z.string(), z.record(z.string(), z.unknown())),
    })
    .passthrough()
    .parse(input);
  for (const profile of Object.values(raw.agents ?? {})) delete profile.token;
  for (const profile of Object.values(raw.humans)) {
    delete profile.token;
    delete profile.token_hash;
  }
  return configSchema.parse(raw);
}
