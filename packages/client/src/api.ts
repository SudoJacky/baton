import {
  operations,
  schemas,
  type ApiErrorBody,
  type Envelope,
  type Input,
  type Operation,
} from '@baton/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly next: string,
  ) {
    super(message);
  }
}
export class BoardClient {
  readonly url: string;
  constructor(
    url: string,
    private readonly access: string | { human?: string } = {},
    readonly sessionId?: string,
  ) {
    const parsed = new URL(url);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      parsed.protocol !== 'http:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        'BOARD_URL must be an HTTP loopback address, without credentials or query parameters.',
      );
    this.url = url.replace(/\/$/, '');
    if (!this.url.endsWith('/api')) this.url += '/api';
    if (typeof access === 'string' && !access)
      throw new Error('Local agent access is missing. Start Baton and use its MCP or CLI.');
    if (typeof access !== 'string' && sessionId)
      throw new Error('A local human client cannot use an agent session.');
  }
  withSession(sessionId: string): BoardClient {
    if (typeof this.access !== 'string')
      throw new Error('Only an agent client can use a session ID.');
    return new BoardClient(this.url, this.access, sessionId);
  }
  private headers(): Record<string, string> {
    return typeof this.access === 'string'
      ? {
          Authorization: `Bearer ${this.access}`,
          ...(this.sessionId ? { 'X-Baton-Session': this.sessionId } : {}),
        }
      : {
          'X-Baton-Client': 'local',
          ...(this.access.human ? { 'X-Baton-Human': this.access.human } : {}),
        };
  }
  async call<T = unknown, K extends Operation = Operation>(
    operation: K,
    input: Input<K>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const params = { ...schemas[operation].parse(input) } as Record<string, unknown>;
    const definition = operations[operation];
    const path = definition.path.replace(/:([a-z_]+)/g, (_, key: string) => {
      const value = params[key];
      delete params[key];
      return encodeURIComponent(String(value));
    });
    const target = new URL(`${this.url}${path}`);
    if (definition.method === 'GET')
      for (const [key, value] of Object.entries(params))
        if (value !== undefined) target.searchParams.set(key, String(value));
    const response = await fetch(target, {
      method: definition.method,
      headers: {
        ...this.headers(),
        ...(definition.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: definition.method === 'GET' ? undefined : JSON.stringify(params),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(operation === 'wait_inbox' ? 65000 : 35000),
      ]),
      redirect: 'error',
    });
    if (!response.ok) {
      let error: ApiErrorBody;
      try {
        error = (await response.json()) as ApiErrorBody;
      } catch {
        throw new ApiError(
          response.status,
          'invalid_response',
          `The server returned HTTP ${response.status}.`,
          'Check BOARD_URL and the server log.',
        );
      }
      throw new ApiError(response.status, error.error.code, error.error.message, error.error.next);
    }
    return (await response.json()) as Envelope<T>;
  }
  async stream(
    cursor: number,
    onEvent: (event: import('@baton/shared').BoardEvent) => void,
    signal: AbortSignal,
    onConnect?: () => void,
  ): Promise<void> {
    const response = await fetch(`${this.url}/events/stream`, {
      headers: {
        ...this.headers(),
        'Last-Event-ID': String(cursor),
      },
      signal,
      redirect: 'error',
    });
    if (!response.ok || !response.body)
      throw new ApiError(
        response.status,
        'stream_failed',
        'Cannot connect to the event stream.',
        'Check authentication and the server.',
      );
    onConnect?.();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += value.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (data) onEvent(JSON.parse(data) as import('@baton/shared').BoardEvent);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
