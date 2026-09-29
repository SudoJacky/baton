import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);

export async function connectionGuide(config: string, host?: string) {
  if (host && !['codex', 'claude-code'].includes(host))
    throw new Error('Host must be codex or claude-code.');
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
    name: string;
    version: string;
    private?: boolean;
  };
  // Published configs use a pinned npm package, never a disposable npx cache path.
  const command = manifest.private
    ? process.execPath
    : process.platform === 'win32'
      ? 'cmd.exe'
      : 'npx';
  const args = manifest.private
    ? [fileURLToPath(new URL('./launcher.js', import.meta.url)), 'mcp', '--config', config]
    : [
        ...(process.platform === 'win32' ? ['/d', '/c', 'npx'] : []),
        '-y',
        `${manifest.name}@${manifest.version}`,
        'mcp',
        '--config',
        config,
      ];
  const quote = (arg: string) =>
    process.platform === 'win32'
      ? `'${arg.replaceAll("'", "''")}'`
      : `'${arg.replaceAll("'", "'\\''")}'`;
  const skillCommand = manifest.private
    ? `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(fileURLToPath(new URL('./launcher.js', import.meta.url)))} install-skill`
    : `npx ${manifest.name}@${manifest.version} install-skill`;
  const lines = ['接入 Agent：将对应配置合入宿主的 MCP 设置，然后重新加载 MCP 连接。'];
  if (!host || host === 'codex') {
    lines.push(
      '\nCodex (TOML):',
      '[mcp_servers.agent_board]',
      `command = ${JSON.stringify(command)}`,
      `args = ${JSON.stringify(args)}`,
    );
  }
  if (!host || host === 'claude-code')
    lines.push(
      '\nClaude Code (JSON):',
      JSON.stringify({ mcpServers: { agent_board: { command, args } } }, null, 2),
    );
  lines.push(
    '\n请保留宿主已有配置。Agent 首次调用 join，随后用返回的 session_id 调用 doctor 检查身份。',
    `可选：运行 ${skillCommand} 安装 Codex 的 $baton 技能；技能不启动服务。`,
    '代码任务还需要 Git；目标工作树在创建任务时选择。',
  );
  return lines.join('\n');
}

export async function installSkill() {
  const source = fileURLToPath(new URL('skills/baton', root));
  const entries = await readdir(source);
  const target = resolve(process.env.CODEX_HOME ?? resolve(homedir(), '.codex'), 'skills/baton');
  await mkdir(dirname(target), { recursive: true });
  // Reserve the directory before copying; never merge over a customized installed skill.
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Skill already exists: ${target}. Move it aside before installing this version.`,
      );
    throw error;
  }
  for (const entry of entries)
    await cp(resolve(source, entry), resolve(target, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  return target;
}

export async function openBrowser(url: string) {
  // The address comes from the loopback listener, not from user-provided shell text.
  const [command, args] =
    process.platform === 'win32'
      ? (['rundll32.exe', ['url.dll,FileProtocolHandler', url]] as const)
      : process.platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Browser opener exited with ${code}.`)),
    );
  });
}
