import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEvidence, submissionEvidence } from '../src/evidence.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'baton-manifest-test-'));
  directories.push(directory);
  const run = randomUUID();
  const timestamp = new Date().toISOString();
  const capture = async (name: string, path = `${name}/output.log`) => {
    await mkdir(join(directory, name));
    await writeFile(join(directory, name, 'output.log'), name);
    await writeFile(
      join(directory, name, 'evidence.json'),
      JSON.stringify({ evidence: [{ path, scope: name }] }),
    );
  };
  return {
    directory,
    run,
    timestamp,
    capture,
    prepare: () => prepareEvidence(directory, run, null, [], timestamp),
    submit: (manifest: string, evidence: { path: string; scope: string }[] = []) =>
      submissionEvidence(directory, run, 'a'.repeat(40), evidence, manifest, timestamp),
  };
}

it('rejects empty, incomplete and malformed captured manifests instead of silently omitting checks', async () => {
  const f = await fixture();
  await expect(f.prepare()).rejects.toMatchObject({ code: 'evidence_required' });
  await mkdir(join(f.directory, 'check-incomplete'));
  await expect(f.prepare()).rejects.toMatchObject({ code: 'invalid_evidence_manifest' });
  await writeFile(join(f.directory, 'check-incomplete', 'evidence.json'), '{broken');
  await expect(f.prepare()).rejects.toMatchObject({ code: 'invalid_evidence_manifest' });
  await writeFile(
    join(f.directory, 'check-incomplete', 'evidence.json'),
    JSON.stringify({ evidence: [{ path: 'output.log' }] }),
  );
  await expect(f.prepare()).rejects.toMatchObject({ code: 'invalid_evidence_manifest' });
});

it('rejects missing files and duplicate paths both within aggregation and across manifest and explicit entries', async () => {
  const f = await fixture();
  await f.capture('check-a', 'missing.txt');
  await expect(f.prepare()).rejects.toMatchObject({ code: 'evidence_unreadable' });
  await writeFile(join(f.directory, 'missing.txt'), 'now present');
  const first = await f.prepare();
  await expect(
    f.submit(first.evidence_manifest, [{ path: 'missing.txt', scope: 'Duplicate' }]),
  ).rejects.toMatchObject({ code: 'duplicate_evidence' });
  await f.capture('check-b', 'missing.txt');
  await expect(f.prepare()).rejects.toMatchObject({ code: 'duplicate_evidence' });
  await rm(join(f.directory, 'missing.txt'));
  await expect(f.submit(first.evidence_manifest)).rejects.toMatchObject({
    code: 'evidence_unreadable',
  });
});

it('rejects foreign manifests, copied run identities and symlink escapes', async () => {
  const f = await fixture();
  const foreign = await fixture();
  await foreign.capture('check-a');
  const prepared = await foreign.prepare();
  await expect(f.submit(prepared.evidence_manifest)).rejects.toMatchObject({
    code: 'evidence_outside_run',
  });
  const copy = join(f.directory, 'copied.json');
  const original = JSON.parse(await readFile(prepared.evidence_manifest, 'utf8'));
  await writeFile(copy, JSON.stringify(original));
  await expect(f.submit(copy)).rejects.toMatchObject({ code: 'evidence_run_mismatch' });
  await writeFile(copy, JSON.stringify({ ...original, run_id: f.run }));
  await expect(f.submit(copy)).rejects.toMatchObject({ code: 'evidence_outside_run' });
  await symlink(join(foreign.directory, 'check-a'), join(f.directory, 'check-linked'), 'junction');
  await expect(f.prepare()).rejects.toMatchObject({ code: 'evidence_outside_run' });
  await symlink(foreign.directory, join(f.directory, 'foreign'), 'junction');
  await expect(
    f.submit(join(f.directory, 'foreign', prepared.evidence_manifest.split(/[\\/]/).at(-1)!)),
  ).rejects.toMatchObject({ code: 'evidence_outside_run' });
});

it('keeps snapshots independent and checks content again at submission', async () => {
  const f = await fixture();
  await f.capture('check-a');
  const first = await f.prepare();
  await f.capture('check-b');
  const second = await f.prepare();
  expect(second.evidence_manifest).not.toBe(first.evidence_manifest);
  expect(await f.submit(first.evidence_manifest)).toHaveLength(1);
  expect(await f.submit(second.evidence_manifest)).toHaveLength(2);
  await writeFile(join(f.directory, 'check-a', 'output.log'), 'altered');
  await expect(f.submit(first.evidence_manifest)).rejects.toMatchObject({
    code: 'evidence_changed',
  });
});

it('enforces the combined evidence limit', async () => {
  const f = await fixture();
  await f.capture('check-a');
  const manifest = await f.prepare();
  await expect(
    f.submit(
      manifest.evidence_manifest,
      Array.from({ length: 100 }, (_, i) => ({ path: `extra-${i}`, scope: 'extra' })),
    ),
  ).rejects.toMatchObject({ code: 'too_many_evidence' });
});
