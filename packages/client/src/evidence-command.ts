import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import spawn from 'cross-spawn';

export async function captureEvidence(outputDirectory: string, scope: string, command: string[]) {
  if (!isAbsolute(outputDirectory))
    throw new Error('--output-dir must be the absolute evidence_directory returned by Baton.');
  if (!scope.trim() || !command.length)
    throw new Error('A command and verification scope are required.');
  await mkdir(outputDirectory, { recursive: true });
  const directory = await mkdtemp(join(outputDirectory, 'check-'));
  const output = join(directory, 'output.log');
  const fd = openSync(output, 'wx');
  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    const child = spawn(command[0]!, command.slice(1), {
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      },
    );
  } finally {
    closeSync(fd);
  }
  const evidence = [
    { path: output, command, ...(code === null ? {} : { exit_code: code }), scope },
  ];
  const manifest = join(directory, 'evidence.json');
  await writeFile(
    manifest,
    JSON.stringify({ evidence, signal, cwd: process.cwd() }, null, 2) + '\n',
    { flag: 'wx' },
  );
  return { evidence, manifest, exit_code: code, signal };
}
