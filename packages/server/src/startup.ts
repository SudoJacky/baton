import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { configSchema } from '@baton/shared';
import { defaultConfig } from '@baton/shared/local';

/** Only a missing file is a new install. Invalid or unreadable configs must fail. */
export async function loadStartupConfig(path: string, port?: number) {
  try {
    return { config: configSchema.parse(parse(await readFile(path, 'utf8'))), created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = defaultConfig('dax', `http://127.0.0.1:${port ?? 4100}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, stringify(config), { flag: 'wx', mode: 0o600 });
    await chmod(path, 0o600);
    return { config, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { config: configSchema.parse(parse(await readFile(path, 'utf8'))), created: false };
  }
}
