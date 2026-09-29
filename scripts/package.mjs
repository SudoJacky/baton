import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const output = resolve(root, 'output/npm');
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(output, 'package-'));
const dependencies = {};
for (const name of ['shared', 'server', 'client']) {
  const pkg = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
  for (const [dependency, version] of Object.entries(pkg.dependencies)) {
    if (!dependency.startsWith('@baton/')) dependencies[dependency] = version;
  }
}
// Inline only our workspace packages. Runtime packages keep their own assets and
// module resolution (notably Fastify logging and node-notifier executables).
await build({
  absWorkingDir: root,
  entryPoints: [
    'packages/server/src/main.ts',
    'packages/client/src/launcher.ts',
    'packages/client/src/onboarding.ts',
    'packages/client/src/cli.ts',
    'packages/client/src/mcp.ts',
  ].map((entry) => ({ in: entry, out: entry.replace('/src/', '/dist/').replace(/\.ts$/, '') })),
  outdir: staging,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: Object.keys(dependencies),
});
await cp(join(root, 'packages/web/dist'), join(staging, 'packages/web/dist'), { recursive: true });
await cp(join(root, 'skills/baton'), join(staging, 'skills/baton'), { recursive: true });
await cp(join(root, 'LICENSE'), join(staging, 'LICENSE'));
await cp(join(root, 'docs/npm-README.md'), join(staging, 'README.md'));
await writeFile(
  join(staging, 'package.json'),
  JSON.stringify(
    {
      name: '@sudojacky/baton',
      version: manifest.version,
      description: 'A local task board and handoff protocol for independent AI agent sessions.',
      license: 'MIT',
      type: 'module',
      engines: manifest.engines,
      bin: { baton: './packages/client/dist/launcher.js' },
      files: ['packages', 'skills', 'README.md', 'LICENSE'],
      repository: { type: 'git', url: 'git+https://github.com/SudoJacky/baton.git' },
      publishConfig: { access: 'public' },
      dependencies,
    },
    null,
    2,
  ) + '\n',
);

// npm_execpath is pnpm when invoked through `pnpm package`; pack produces the
// same standard npm tarball without publishing or requiring npm credentials.
const packer = process.env.npm_execpath;
if (!packer) throw new Error('Run through pnpm package.');
execFileSync(process.execPath, [packer, 'pack', '--pack-destination', output], {
  cwd: staging,
  stdio: 'inherit',
  windowsHide: true,
});
console.log(`Distribution: ${join(output, `sudojacky-baton-${manifest.version}.tgz`)}`);
