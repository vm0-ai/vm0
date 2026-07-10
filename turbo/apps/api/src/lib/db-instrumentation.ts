import { performance } from "node:perf_hooks";

import {
  context,
  createContextKey,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { Pool, PoolClient } from "pg";

import { deriveSqlSpanName } from "./sql-span-name";

const POOL_QUERY_SPAN_KEY = createContextKey("vm0.pg.pool-query-span");
const POOL_ACQUIRE_DURATION_ATTRIBUTE = "vm0.db.pool.acquire.duration_ms";
const POOL_ACQUIRE_PATH_ATTRIBUTE = "vm0.db.pool.acquire.path";

type AnyArgs = readonly unknown[];
type PgQuery = (...args: AnyArgs) => unknown;
type PoolAcquirePath = "idle" | "new" | "queued";
type PoolRelease = (error?: Error | boolean) => void;
type PoolConnectCallback = (
  error: Error | undefined,
  client?: PoolClient,
  release?: PoolRelease,
) => void;

class PoolQuerySpan {
  constructor(readonly span: Span) {}
}

function extractSql(args: AnyArgs): string {
  const first = args[0];
  if (typeof first === "string") {
    return first;
  }
  if (
    first &&
    typeof first === "object" &&
    "text" in first &&
    typeof first.text === "string"
  ) {
    return first.text;
  }
  return "pg.query";
}

function acquisitionPath(pool: Pool): PoolAcquirePath {
  // With no idle client, pg-pool either starts a connection immediately or
  // queues solely based on whether the pool is full. This can leapfrog older
  // waiters while a removed client is still closing.
  if (pool.idleCount === 0) {
    return pool.totalCount < pool.options.max ? "new" : "queued";
  }

  // Idle delivery is deferred to the next tick, so a synchronous burst can
  // observe the same idle clients before earlier waiters receive them. Treat
  // waitingCount as the new request's zero-based position and reserve both
  // idle clients and remaining connection slots for earlier requests.
  const position = pool.waitingCount;
  if (position < pool.idleCount) {
    return "idle";
  }
  const availableClientCount =
    pool.idleCount + pool.options.max - pool.totalCount;
  if (position < availableClientCount) {
    return "new";
  }
  return "queued";
}

function isPoolConnectCallback(value: unknown): value is PoolConnectCallback {
  return typeof value === "function";
}

function instrumentQuery(
  target: object,
  original: PgQuery,
  tracer: Tracer,
  markPoolQuery: boolean,
): PgQuery {
  return function instrumentedQuery(this: unknown, ...args: AnyArgs): unknown {
    // pg query is overloaded: when the caller passes a trailing callback
    // (pool.query does this internally to drive client.query), the result is
    // undefined and the callback is the only completion signal. The outer
    // pool query already produced a span, so pass callback-style client
    // queries straight through.
    if (typeof args[args.length - 1] === "function") {
      return Reflect.apply(original, target, args);
    }

    const sql = extractSql(args);
    const spanName = deriveSqlSpanName(sql) ?? "pg.query";
    return tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "db.system": "postgresql",
          "db.statement": sql,
        },
      },
      (span) => {
        // Pool-level queries mark their exact outer span while pg-pool
        // synchronously calls connect(callback). The callback may run much
        // later, so acquisition instrumentation captures this marked span at
        // connect entry instead of looking up whichever request context is
        // active when a queued client finally becomes available.
        const execute = (): Promise<unknown> => {
          return Reflect.apply(original, target, args) as Promise<unknown>;
        };
        const query =
          markPoolQuery && span.isRecording()
            ? context.with(
                context
                  .active()
                  .setValue(POOL_QUERY_SPAN_KEY, new PoolQuerySpan(span)),
                execute,
              )
            : execute();

        // The span parents to whatever request span is active when the query
        // starts. Slice DB spans by route via a trace_id join to the Hono
        // server span; never copy request-scoped attributes onto pooled
        // client spans.
        return query
          .then(
            (result) => {
              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            },
            (error: unknown) => {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
              });
              span.recordException(
                error instanceof Error ? error : String(error),
              );
              throw error;
            },
          )
          .finally(() => {
            span.end();
          });
      },
    );
  } as PgQuery;
}

export function instrumentPgPool(pool: Pool, tracer: Tracer): Pool {
  const originalQuery = pool.query.bind(pool) as PgQuery;
  pool.query = instrumentQuery(
    pool,
    originalQuery,
    tracer,
    true,
  ) as Pool["query"];

  const instrumentedClients = new WeakSet<PoolClient>();
  const originalConnect = pool.connect.bind(pool);
  pool.connect = function patchedConnect(...args: AnyArgs) {
    const callback = args[args.length - 1];
    if (isPoolConnectCallback(callback)) {
      const markedSpan = context.active().getValue(POOL_QUERY_SPAN_KEY);
      if (!(markedSpan instanceof PoolQuerySpan)) {
        return Reflect.apply(originalConnect, pool, args);
      }

      const startedAt = performance.now();
      const path = acquisitionPath(pool);
      const wrappedCallback: PoolConnectCallback = (error, client, release) => {
        markedSpan.span.setAttributes({
          [POOL_ACQUIRE_DURATION_ATTRIBUTE]: performance.now() - startedAt,
          [POOL_ACQUIRE_PATH_ATTRIBUTE]: path,
        });
        callback(error, client, release);
      };
      const wrappedArgs = [...args.slice(0, -1), wrappedCallback] as const;
      return Reflect.apply(originalConnect, pool, wrappedArgs);
    }

    const promise = Reflect.apply(
      originalConnect,
      pool,
      args,
    ) as Promise<PoolClient>;
    return promise.then((client) => {
      if (instrumentedClients.has(client)) {
        return client;
      }
      const clientQuery = client.query.bind(client) as PgQuery;
      client.query = instrumentQuery(
        client,
        clientQuery,
        tracer,
        false,
      ) as PoolClient["query"];
      instrumentedClients.add(client);
      return client;
    });
  } as Pool["connect"];

  return pool;
}
