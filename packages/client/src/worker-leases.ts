import type { WorkerAssignment } from '@baton/shared';
import { ApiError, type BoardClient } from './api.js';

/** The MCP transport, not the model, keeps dispatched work alive. */
export class WorkerLeases {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private managed = new Set<string>();
  private renewed = new Map<string, string>();
  private failures = new Map<string, string>();
  constructor(private readonly client: BoardClient) {}
  track(assignment: WorkerAssignment): void {
    if (assignment.state === 'active' && this.managed.has(assignment.run_id)) return;
    this.stop(assignment.run_id);
    if (this.closed || assignment.state !== 'active') return;
    const { run_id, heartbeat_after_ms } = assignment;
    this.managed.add(run_id);
    const pulse = async () => {
      this.timers.delete(run_id);
      try {
        const result = await this.client.call<{ state: string }>('worker_heartbeat', { run_id });
        if (result.data.state !== 'active') {
          this.stop(run_id);
          return;
        }
        this.renewed.set(run_id, new Date().toISOString());
        this.failures.delete(run_id);
      } catch (error) {
        this.failures.set(run_id, error instanceof Error ? error.message : String(error));
        console.error(
          `Baton worker heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (error instanceof ApiError && error.status < 500) {
          this.stop(run_id);
          return;
        }
      }
      if (!this.closed && this.managed.has(run_id) && !this.timers.has(run_id))
        this.timers.set(
          run_id,
          setTimeout(() => {
            void pulse();
          }, heartbeat_after_ms),
        );
    };
    this.timers.set(
      run_id,
      setTimeout(() => {
        void pulse();
      }, heartbeat_after_ms),
    );
  }
  stop(id: string): void {
    this.managed.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
  status(id: string) {
    return {
      managed_here: this.managed.has(id),
      last_success_at: this.renewed.get(id) ?? null,
      last_error: this.failures.get(id) ?? null,
    };
  }
  close(): void {
    this.closed = true;
    this.managed.clear();
    this.renewed.clear();
    this.failures.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
