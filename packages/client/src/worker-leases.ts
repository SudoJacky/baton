import type { WorkerAssignment } from '@baton/shared';
import { ApiError, type BoardClient } from './api.js';

/** The MCP transport, not the model, keeps dispatched work alive. */
export class WorkerLeases {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(private readonly client: BoardClient) {}
  track(assignment: WorkerAssignment): void {
    if (assignment.state === 'active' && this.timers.has(assignment.run_id)) return;
    this.stop(assignment.run_id);
    if (this.closed || assignment.state !== 'active') return;
    const { run_id, heartbeat_after_ms } = assignment;
    const pulse = async () => {
      this.timers.delete(run_id);
      try {
        const result = await this.client.call<{ state: string }>('worker_heartbeat', { run_id });
        if (result.data.state !== 'active') return;
      } catch (error) {
        console.error(
          `Baton worker heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (error instanceof ApiError && error.status < 500) return;
      }
      if (!this.closed && !this.timers.has(run_id))
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
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
