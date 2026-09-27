// Run from the task repository. Pass the run's evidence_directory, never a shared screenshot path.
// node /path/to/baton/templates/run-check.ts --output-dir <directory> --scope "..." -- node --test
import { parseArgs } from 'node:util';
import { captureEvidence } from '../packages/client/dist/evidence-command.js';

const { values, positionals } = parseArgs({
  options: { 'output-dir': { type: 'string' }, scope: { type: 'string' } },
  allowPositionals: true,
});
if (!values['output-dir'] || !values.scope)
  throw new Error('Provide --output-dir and --scope, then -- and the command.');
const result = await captureEvidence(values['output-dir'], values.scope, positionals);
console.log(JSON.stringify(result));
process.exitCode = result.exit_code ?? 1;
