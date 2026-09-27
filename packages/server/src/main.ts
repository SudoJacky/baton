import { mkdir, readFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { configSchema } from '@baton/shared';
import { ensureLocalAccess } from '@baton/shared/local';
import { Board } from './board.js';
import { createApp } from './app.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    database: { type: 'string' },
    port: { type: 'string' },
    'evidence-directory': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'Baton server\n  --config <agents.yaml>  default: ~/.agent-board/agents.yaml\n  --database <path>       default: <config-directory>/board.sqlite\n  --port <number>         default: 4100; always binds 127.0.0.1\nSelect a repository when creating or updating a task, not when starting the server.',
  );
} else {
  let board: Board | undefined;
  try {
    const configPath = resolve(
      values.config ?? process.env.BOARD_CONFIG ?? resolve(homedir(), '.agent-board/agents.yaml'),
    );
    const config = configSchema.parse(parse(await readFile(configPath, 'utf8')));
    const database = resolve(values.database ?? resolve(dirname(configPath), 'board.sqlite'));
    const port = Number(
      (values.port ?? process.env.BOARD_PORT ?? new URL(config.url).port) || 4100,
    );
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('Port must be an integer from 0 to 65535.');
    await mkdir(dirname(database), { recursive: true, mode: 0o700 });
    board = new Board({
      database,
      config,
      agentToken: await ensureLocalAccess(configPath),
      evidenceDirectory: values['evidence-directory'],
    });
    await chmod(database, 0o600);
    const app = await createApp(board, {
      webRoot: fileURLToPath(new URL('../../web/dist', import.meta.url)),
      logger: true,
    });
    const address = await app.listen({ host: '127.0.0.1', port });
    console.log(
      `Baton dashboard: ${address}\nRepositories are selected per task.\nLocal user: @${board.localHuman().handle}. Open the dashboard; no login is required.`,
    );
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await app.close();
      board!.close();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
      process.once(signal, () => {
        void close().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      });
  } catch (error) {
    board?.close();
    console.error(
      `Cannot start Baton: ${error instanceof Error ? error.message : String(error)}\nNew install: pnpm board init\nLegacy config: run pnpm board --config <agents.yaml> migrate, then restart.`,
    );
    process.exitCode = 1;
  }
}
