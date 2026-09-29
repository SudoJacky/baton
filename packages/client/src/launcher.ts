#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { configPath } from './identity.js';
import { connectionGuide, installSkill } from './onboarding.js';

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error(`Baton requires Node.js 24 or later; found ${process.versions.node}.`);
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args.shift()! : 'start';
  if (command === 'setup') {
    const { values } = parseArgs({
      args,
      options: { config: { type: 'string' }, host: { type: 'string' } },
    });
    console.log(await connectionGuide(configPath(values.config), values.host));
  } else if (command === 'install-skill') {
    parseArgs({ args, options: {} });
    console.log(`Baton skill installed: ${await installSkill()}`);
  } else if (['start', 'mcp', 'board'].includes(command)) {
    // Keep the existing entry points and their argument parsers intact.
    process.argv = [process.argv[0]!, process.argv[1]!, ...args];
    if (command === 'start') {
      const noOpen = args.includes('--no-open');
      process.argv = process.argv.filter((arg) => arg !== '--no-open');
      if (!noOpen) process.argv.push('--open');
      process.argv.push('--guide');
      await import(new URL('../../server/dist/main.js', import.meta.url).href);
    } else if (command === 'mcp') await import(new URL('./mcp.js', import.meta.url).href);
    else await import(new URL('./cli.js', import.meta.url).href);
  } else {
    throw new Error(`Unknown command: ${command}. Use start, setup, install-skill, mcp or board.`);
  }
}

void main().catch((error) => {
  console.error(`Cannot run Baton: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
