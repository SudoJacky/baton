import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { BoardError, requireCondition } from './errors.js';

const exec = promisify(execFile);
export async function resolveRepository(repository: string): Promise<string> {
  requireCondition(
    isAbsolute(repository),
    'invalid_repository',
    'Repository must be an absolute path on the server machine.',
    'Pass the full path to a local Git working tree.',
    400,
  );
  try {
    const { stdout } = await exec('git', ['-C', repository, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    // Subdirectories and symlink aliases share a working-tree lock. Worktrees remain independent.
    const root = normalize(await realpath(stdout.trim()));
    return process.platform === 'win32' ? root.toLowerCase() : root;
  } catch {
    throw new BoardError(
      400,
      'invalid_repository',
      'Cannot open this Git working tree.',
      'Use an existing, non-bare Git repository path accessible to the Baton server.',
    );
  }
}
export async function verifyCommit(repository: string, sha: string): Promise<void> {
  requireCondition(
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha),
    'invalid_commit',
    'A full commit SHA is required.',
    'Commit your work and attach the full SHA as a commit artifact.',
    400,
  );
  const git = async (...args: string[]) =>
    (
      await exec('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      })
    ).stdout.trim();
  try {
    const [commit, head] = await Promise.all([
      git('rev-parse', '--verify', `${sha}^{commit}`),
      git('rev-parse', 'HEAD'),
    ]);
    requireCondition(
      commit === head,
      'commit_not_head',
      'The submitted commit is not the repository HEAD.',
      'Submit the current committed version; coordinate repository changes through the write lock.',
    );
    requireCondition(
      (await git('status', '--porcelain', '--untracked-files=all')) === '',
      'dirty_worktree',
      'The repository contains uncommitted or untracked changes.',
      'Commit all task changes. Put generated reports in an ignored directory before submitting.',
    );
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError(
      409,
      'git_verification_failed',
      'Could not verify the submitted commit in the task repository.',
      'Check the task repository and ensure the commit exists locally.',
    );
  }
}
