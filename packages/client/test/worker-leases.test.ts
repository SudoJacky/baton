import { afterEach, expect, it, vi } from 'vitest';
import type { WorkerAssignment } from '@baton/shared';
import { BoardClient } from '../src/api.js';
import { WorkerLeases } from '../src/worker-leases.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('reports failed renewals until a successful heartbeat and does not restart a stopped in-flight lease', async () => {
  vi.useFakeTimers();
  const call = vi.spyOn(BoardClient.prototype, 'call');
  call.mockRejectedValueOnce(new Error('Server unavailable'));
  call.mockResolvedValue({ data: { state: 'active' } });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const leases = new WorkerLeases(new BoardClient('http://127.0.0.1:4100', 'test-access'));
  const assignment = {
    run_id: 'test-run',
    state: 'active',
    heartbeat_after_ms: 100,
  } as WorkerAssignment;
  try {
    leases.track(assignment);
    await vi.advanceTimersByTimeAsync(100);
    expect(leases.status('test-run')).toMatchObject({
      managed_here: true,
      last_success_at: null,
      last_error: 'Server unavailable',
    });
    expect(log).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(leases.status('test-run')).toMatchObject({
      managed_here: true,
      last_success_at: expect.any(String),
      last_error: null,
    });
    let finish!: (value: { data: { state: string } }) => void;
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(100);
    leases.stop('test-run');
    finish({ data: { state: 'active' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toHaveBeenCalledTimes(3);
    expect(leases.status('test-run').managed_here).toBe(false);
  } finally {
    leases.close();
  }
});
