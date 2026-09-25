export class BoardError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly next: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
export function requireCondition(
  condition: unknown,
  code: string,
  message: string,
  next: string,
  status = 409,
): asserts condition {
  if (!condition) throw new BoardError(status, code, message, next);
}
