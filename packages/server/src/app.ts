import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  operations,
  schemas,
  handleSchema,
  type Envelope,
  type Mention,
  type Operation,
  type Participant,
} from '@baton/shared';
import { Board } from './board.js';
import { BoardError, requireCondition as check } from './errors.js';

function credentials(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}
function parseQuery(query: unknown): Record<string, unknown> {
  const output = { ...(query as Record<string, unknown>) };
  if (output.repository === 'null') output.repository = null;
  for (const key of ['id', 'parent', 'task_id', 'since', 'before', 'limit', 'offset', 'timeout'])
    if (typeof output[key] === 'string') output[key] = Number(output[key]);
  for (const key of ['mine', 'active_only', 'include_thread', 'unread_only']) {
    if (output[key] === 'true') output[key] = true;
    else if (output[key] === 'false') output[key] = false;
  }
  // REST spelling from the plan, while retaining the shared CLI/MCP schema.
  if (output.state === 'unread') {
    output.unread_only = true;
    delete output.state;
  }
  return output;
}

export async function createApp(
  board: Board,
  options: { webRoot?: string; logger?: boolean; sweepInterval?: number } = {},
) {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: ['req.headers.authorization'],
          serializers: { req: (req) => ({ method: req.method, url: req.url }) },
        }
      : false,
    bodyLimit: 256 * 1024,
  });
  const streams = new Set<() => void>();
  app.addHook('onRequest', async (request, reply) => {
    const hostname = request.hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname))
      throw new BoardError(
        403,
        'local_only',
        'This server accepts only local hostnames.',
        'Use http://127.0.0.1:4100.',
      );
    if (request.headers.origin) {
      let sameOrigin = false;
      try {
        sameOrigin =
          new URL(request.headers.origin).origin ===
          new URL(`${request.protocol}://${request.headers.host}`).origin;
      } catch {
        /* Invalid origin is rejected below. */
      }
      if (!sameOrigin)
        throw new BoardError(
          403,
          'origin_rejected',
          'This origin cannot access the local board.',
          'Open the local dashboard directly.',
        );
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    reply.header('X-Frame-Options', 'DENY');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        error: {
          code: 'invalid_input',
          message: 'Request parameters are invalid.',
          next: error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
        },
      });
    if (error instanceof BoardError)
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          next: error.next,
          details: error.details,
        },
      });
    if ((error as { statusCode?: number }).statusCode === 400)
      return reply.status(400).send({
        error: {
          code: 'invalid_json',
          message: 'The request body is not valid JSON.',
          next: 'Send a valid JSON object.',
        },
      });
    request.log.error({ err: error }, 'Unhandled board error');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'The server could not complete the operation.',
        next: 'Inspect the server error log; no partial mutation was committed.',
      },
    });
  });
  const sessionId = (request: FastifyRequest) => {
    const value = request.headers['x-baton-session'];
    return value === undefined ? undefined : z.string().uuid().parse(value);
  };
  const authenticate = (request: FastifyRequest) => {
    const local = request.headers['x-baton-client'];
    const human = request.headers['x-baton-human'];
    if (
      request.headers.authorization !== undefined ||
      request.headers['x-baton-session'] !== undefined
    ) {
      check(
        local === undefined && human === undefined,
        'ambiguous_identity',
        'Agent sessions cannot be combined with a local human identity.',
        'Use one client identity per request.',
        401,
      );
      return board.authenticate(credentials(request), sessionId(request));
    }
    // This non-secret header forces a browser preflight for cross-origin requests.
    // We do not enable CORS. Local processes are trusted and may explicitly use this API.
    check(
      local === 'local',
      'local_client_required',
      'Use the local dashboard or a Baton client.',
      'Open the dashboard directly; no login is required.',
      401,
    );
    return board.localHuman(human === undefined ? undefined : handleSchema.parse(human));
  };
  for (const [operation, route] of Object.entries(operations) as [
    Operation,
    (typeof operations)[Operation],
  ][]) {
    for (const prefix of ['', '/api'])
      app.route({
        method: route.method,
        url: `${prefix}${route.path}`,
        handler: async (request, reply) => {
          board.sweep();
          const input = {
            ...(route.method === 'GET'
              ? parseQuery(request.query)
              : ((request.body as Record<string, unknown>) ?? {})),
            ...parseQuery(request.params),
          };
          if (operation === 'join') return board.join(credentials(request), input);
          const actor = authenticate(request);
          if (operation === 'leave') {
            schemas.leave.parse(input);
            return board.leave(actor, sessionId(request));
          }
          if (operation !== 'wait_inbox') return board.execute(actor, operation, input);
          const p = schemas.wait_inbox.parse(input);
          const read = async () =>
            (await board.execute(authenticate(request), 'wait_inbox', p)) as Envelope<Mention[]>;
          const immediate = await read();
          if (immediate.data.length || p.timeout === 0) return immediate;
          return new Promise<Envelope<Mention[]>>((resolve, reject) => {
            let settled = false;
            const finish = (error?: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              board.changes.off('change', changed);
              reply.raw.off('close', closed);
              streams.delete(closed);
              if (error) reject(error);
              else {
                try {
                  resolve(read());
                } catch (readError) {
                  reject(readError);
                }
              }
            };
            const changed = async () => {
              try {
                if ((await read()).data.length) finish();
              } catch (error) {
                finish(error);
              }
            };
            const closed = () => finish();
            const timer = setTimeout(finish, p.timeout * 1000);
            board.changes.on('change', changed);
            reply.raw.on('close', closed);
            streams.add(closed);
            changed();
          });
        },
      });
  }
  for (const prefix of ['', '/api']) {
    app.get(`${prefix}/health`, async () => ({ status: 'ok' }));
    app.get(`${prefix}/events/stream`, (request, reply) => {
      let actor: Participant = authenticate(request);
      const query = request.query as { since?: string };
      const rawCursor =
        request.headers['last-event-id'] ?? query.since ?? String(board.eventCursor());
      let cursor = z.coerce.number().int().min(0).parse(rawCursor);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write('retry: 2000\n\n');
      let blocked = false;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        board.changes.off('change', drain);
        streams.delete(close);
        reply.raw.off('drain', onDrain);
        reply.raw.off('close', close);
        reply.raw.off('error', close);
        reply.raw.end();
      };
      const drain = () => {
        if (closed || blocked) return;
        try {
          actor = authenticate(request);
          let events;
          do {
            events = board.events(actor, { since: cursor, limit: 100 });
            for (const event of events) {
              cursor = event.id;
              if (
                !reply.raw.write(
                  `id: ${event.id}\nevent: board\ndata: ${JSON.stringify(event)}\n\n`,
                )
              ) {
                blocked = true;
                return;
              }
            }
          } while (events.length === 100);
        } catch (error) {
          request.log.warn({ err: error }, 'Event stream closed');
          close();
        }
      };
      const onDrain = () => {
        blocked = false;
        drain();
      };
      const keepalive = setInterval(() => {
        if (!blocked && !closed) {
          blocked = !reply.raw.write(': heartbeat\n\n');
        }
      }, 15000);
      board.changes.on('change', drain);
      reply.raw.on('drain', onDrain);
      reply.raw.on('close', close);
      reply.raw.on('error', close);
      streams.add(close);
      drain();
    });
  }
  if (options.webRoot && existsSync(options.webRoot))
    await app.register(fastifyStatic, {
      root: options.webRoot,
      prefix: '/',
      index: 'index.html',
      maxAge: 0,
    });
  const timer = setInterval(() => {
    try {
      board.sweep();
    } catch (error) {
      app.log.error({ err: error }, 'Maintenance failed');
    }
  }, options.sweepInterval ?? 10000);
  timer.unref();
  app.addHook('preClose', async () => {
    clearInterval(timer);
    for (const close of [...streams]) close();
  });
  return app;
}
