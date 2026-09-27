import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  evidenceSchema,
  type Evidence,
  type EvidenceInput,
  type PreparedEvidence,
} from '@baton/shared';
import { BoardError, requireCondition as check } from './errors.js';

export function insideDirectory(directory: string, path: string): boolean {
  const suffix = relative(directory, path);
  return (
    Boolean(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  );
}

async function evidenceFile(directory: string, input: string): Promise<string> {
  const requested = resolve(directory, input);
  check(
    insideDirectory(directory, requested),
    'evidence_outside_run',
    'Evidence must belong to this run directory.',
    'Use evidence_directory from get_task.',
    400,
  );
  const root = await realpath(directory);
  const path = await realpath(requested);
  check(
    insideDirectory(root, path),
    'evidence_outside_run',
    'Evidence resolves outside this run directory.',
    'Copy the evidence into your own run directory.',
    400,
  );
  check(
    (await stat(path)).isFile(),
    'invalid_evidence',
    'Evidence must be a file.',
    'Supply a file path.',
    400,
  );
  return path;
}

const capturedSchema = z.object({ evidence: z.array(evidenceSchema).min(1).max(100) });
const manifestSchema = z
  .object({
    version: z.literal(1),
    run_id: z.string().uuid(),
    evidence: z
      .array(
        evidenceSchema.extend({
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size_bytes: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(100),
  })
  .strict();

async function readManifest<T>(directory: string, input: string, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(await evidenceFile(directory, input), 'utf8')));
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError(
      400,
      'invalid_evidence_manifest',
      `Cannot read evidence manifest ${input}: ${error instanceof Error ? error.message : String(error)}`,
      'Finish the captured check and verify its manifest before retrying. No submission was accepted.',
    );
  }
}

/** Build an immutable snapshot after all checks finish; no shared append file to race on. */
export async function prepareEvidence(
  directory: string,
  runId: string,
  sha: string | null,
  additional: EvidenceInput[],
  timestamp: string,
): Promise<PreparedEvidence> {
  const inputs: EvidenceInput[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.name.startsWith('check-') || (!entry.isDirectory() && !entry.isSymbolicLink()))
      continue;
    const captured = await readManifest(
      directory,
      join(entry.name, 'evidence.json'),
      capturedSchema,
    );
    inputs.push(...captured.evidence);
  }
  inputs.push(...additional);
  check(
    inputs.length > 0,
    'evidence_required',
    'No evidence was found for this run.',
    'Run agent-board evidence first, or supply evidence files with path and scope.',
    400,
  );
  const evidence = await collectEvidence(directory, runId, sha, inputs, timestamp);
  const manifest = manifestSchema.parse({
    version: 1,
    run_id: runId,
    evidence: evidence.map(({ path, command, exit_code, scope, sha256, size_bytes }) => ({
      path,
      command,
      exit_code,
      scope,
      sha256,
      size_bytes,
    })),
  });
  const path = join(directory, `manifest-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { run_id: runId, evidence_manifest: path, evidence };
}

export async function submissionEvidence(
  directory: string,
  runId: string,
  sha: string | null,
  inputs: EvidenceInput[],
  manifestPath: string | undefined,
  timestamp: string,
): Promise<Evidence[]> {
  const manifest = manifestPath
    ? await readManifest(directory, manifestPath, manifestSchema)
    : undefined;
  check(
    !manifest || manifest.run_id === runId,
    'evidence_run_mismatch',
    'The evidence manifest belongs to another run.',
    'Prepare evidence using your own run_id.',
    400,
  );
  const entries = manifest?.evidence.map(({ sha256, size_bytes, ...input }) => input) ?? [];
  const evidence = await collectEvidence(directory, runId, sha, [...entries, ...inputs], timestamp);
  for (const [index, expected] of (manifest?.evidence ?? []).entries()) {
    const actual = evidence[index]!;
    check(
      actual.sha256 === expected.sha256 && actual.size_bytes === expected.size_bytes,
      'evidence_changed',
      `Evidence changed after preview: ${actual.path}`,
      'Inspect the changed file and prepare a new evidence manifest before submitting.',
      400,
    );
  }
  return evidence;
}

/** File identity is measured here; command, exit code and scope are worker-reported. */
export async function collectEvidence(
  directory: string,
  runId: string,
  sha: string | null,
  inputs: EvidenceInput[],
  timestamp: string,
): Promise<Evidence[]> {
  check(
    inputs.length <= 100,
    'too_many_evidence',
    'A submission can contain at most 100 evidence files.',
    'Select at most 100 files, including explicit evidence and manifest entries.',
    400,
  );
  const result: Evidence[] = [];
  const paths = new Set<string>();
  for (const input of inputs) {
    try {
      const path = await evidenceFile(directory, input.path);
      check(
        !paths.has(path),
        'duplicate_evidence',
        'Evidence paths must be unique.',
        'List each file once.',
        400,
      );
      paths.add(path);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
        size += chunk.length;
      }
      result.push({
        ...input,
        path,
        run_id: runId,
        commit_sha: sha,
        sha256: hash.digest('hex'),
        size_bytes: size,
        recorded_at: timestamp,
      });
    } catch (error) {
      if (error instanceof BoardError) throw error;
      throw new BoardError(
        400,
        'evidence_unreadable',
        `Cannot read evidence ${input.path}: ${error instanceof Error ? error.message : String(error)}`,
        'Check the file on the Baton server host, then retry. The submission was not accepted.',
      );
    }
  }
  return result;
}
