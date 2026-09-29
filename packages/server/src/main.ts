import { mkdir, access, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureLocalAccess } from '@baton/shared/local';
import { Board } from './board.js';
import { createApp } from './app.js';
import { loadStartupConfig } from './startup.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    database: { type: 'string' },
    port: { type: 'string' },
    'evidence-directory': { type: 'string' },
    help: { type: 'boolean' },
    open: { type: 'boolean' },
    guide: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'Baton\n  baton [start]          initialize if needed and start the dashboard\n  baton setup            show ready-to-copy MCP configuration\n  baton install-skill    install the optional Codex skill\n  baton mcp              run MCP stdio\n  baton board <command>  run the Agent Board CLI\n\n  --config <agents.yaml>  default: ~/.agent-board/agents.yaml\n  --database <path>       default: <config-directory>/board.sqlite\n  --port <number>         default: 4100; always binds 127.0.0.1\n  --no-open              do not open the browser (launcher only)\nSelect a repository when creating or updating a task, not when starting the server.',
  );
} else {
  let board: Board | undefined;
  try {
    const configPath = resolve(
      values.config ?? process.env.BOARD_CONFIG ?? resolve(homedir(), '.agent-board/agents.yaml'),
    );
    const requestedPort = values.port ?? process.env.BOARD_PORT;
    if (
      requestedPort !== undefined &&
      (!/^\d+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535)
    )
      throw new Error('Port must be an integer from 1 to 65535.');
    const { config, created } = await loadStartupConfig(
      configPath,
      requestedPort === undefined ? undefined : Number(requestedPort),
    );
    const database = resolve(values.database ?? resolve(dirname(configPath), 'board.sqlite'));
    const port = Number(
      (values.port ?? process.env.BOARD_PORT ?? new URL(config.url).port) || 4100,
    );
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Port must be an integer from 1 to 65535.');
    if (Number(new URL(config.url).port || 80) !== port)
      throw new Error(
        `Port ${port} does not match config.url (${config.url}). Update the config URL so the server and MCP use the same address.`,
      );
    const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
    await access(resolve(webRoot, 'index.html'));
    const onboarding =
      values.guide || values.open
        ? ((await import(new URL('../../client/dist/onboarding.js', import.meta.url).href)) as {
            connectionGuide: (config: string) => Promise<string>;
            openBrowser: (url: string) => Promise<void>;
          })
        : undefined;
    const guide = values.guide ? await onboarding!.connectionGuide(configPath) : undefined;
    await mkdir(dirname(database), { recursive: true, mode: 0o700 });
    board = new Board({
      database,
      config,
      agentToken: await ensureLocalAccess(configPath),
      evidenceDirectory: values['evidence-directory'],
    });
    await chmod(database, 0o600);
    const app = await createApp(board, {
      webRoot,
      logger: true,
    });
    const address = await app.listen({ host: '127.0.0.1', port });
    console.log(
      `Baton dashboard: ${address}\nRepositories are selected per task.\nLocal user: @${board.localHuman().handle}. Open the dashboard; no login is required.`,
    );
    console.log(
      `${created ? 'Created' : 'Using'} config: ${configPath}\nDatabase: ${database}\nKeep this terminal open. Press Ctrl+C to stop.`,
    );
    if (guide) console.log(`\n${guide}`);
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
    if (values.open) {
      try {
        await onboarding!.openBrowser(address);
      } catch (error) {
        console.error(
          `Cannot open the browser: ${error instanceof Error ? error.message : String(error)}\nOpen ${address} manually; Baton is running.`,
        );
      }
    }
  } catch (error) {
    board?.close();
    console.error(
      `Cannot start Baton: ${error instanceof Error ? error.message : String(error)}\nCheck the configuration, permissions and port. Existing data has not been reset.`,
    );
    process.exitCode = 1;
  }
}
