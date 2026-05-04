import {
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { schema } from "@vm0/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryConfig } from "pg";

import { env } from "./env";
import { singleton } from "./singleton";
import { deriveSqlSpanName } from "./sql-span-name";

const HTTP_ROUTE_BAGGAGE_KEY = "http.route";

const pool = singleton((): Pool => {
  // `@opentelemetry/instrumentation-pg` would normally hook `pg.Pool` via
  // `require-in-the-middle`, but `vercel deploy --prebuilt --archive=tgz`
  // bundles the api into a single `index.js` so the require hook never fires.
  // Hook the `Pool` instance ourselves at lazy-init time — bundle-safe and
  // covers every code path because every drizzle/pg call funnels through this
  // singleton. `tracer.startActiveSpan` is a no-op when no provider is
  // registered (i.e. `pnpm dev` / vitest without VERCEL_GIT_COMMIT_SHA), so the
  // wrap stays cheap when OTel is off.
  const tracer = trace.getTracer("vm0-api/pg");

  type AnyArgs = readonly unknown[];
  type PgQuery = (...args: AnyArgs) => unknown;

  function extractSql(args: AnyArgs): string {
    const first = args[0];
    if (typeof first === "string") {
      return first;
    }
    if (first && typeof first === "object" && "text" in first) {
      const config = first as QueryConfig;
      return config.text;
    }
    return "pg.query";
  }

  function instrumentQuery(target: object, original: PgQuery): PgQuery {
    return function instrumentedQuery(
      this: unknown,
      ...args: AnyArgs
    ): unknown {
      // pg's `query()` is overloaded: when the caller passes a trailing
      // callback (`pool.query` itself does this internally to drive
      // `client.query`) the result is `undefined` and the user's callback is
      // the only completion signal. We can't wrap that into a Promise without
      // intercepting the callback, and pool.query above already produced a
      // span for the outer call — so just pass it straight through.
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
          const route = propagation
            .getActiveBaggage()
            ?.getEntry(HTTP_ROUTE_BAGGAGE_KEY)?.value;
          if (route) {
            span.setAttribute("http.route", route);
          }
          // Promise chain instead of try/catch so this file doesn't have to
          // opt out of `no-restricted-syntax` (the api package centralises
          // guarded operations). `.then(onOk, onErr)` covers both branches in
          // a single pass; `.finally(span.end)` runs whichever branch fired.
          return (Reflect.apply(original, target, args) as Promise<unknown>)
            .then(
              (result) => {
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
              },
              (error: unknown) => {
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
                span.recordException(error as Error);
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

  function instrumentPool(target: Pool): Pool {
    const originalQuery = target.query.bind(target) as PgQuery;
    target.query = instrumentQuery(target, originalQuery) as Pool["query"];

    // pg-pool's `pool.query()` internally calls `pool.connect(callback)` to
    // acquire a client — that path is already covered by the wrapped
    // `pool.query` above, so leave callback-style connect alone (replacing
    // the callback would double-wrap and the callback would never fire).
    // Promise-style `pool.connect()` is what drizzle uses for transactions —
    // patch the returned client's `query` so the BEGIN/COMMIT plus every
    // statement inside the transaction emit CLIENT spans too.
    const originalConnect = target.connect.bind(target);
    target.connect = function patchedConnect(...args: AnyArgs) {
      if (typeof args[args.length - 1] === "function") {
        return Reflect.apply(originalConnect, target, args);
      }
      const promise = Reflect.apply(
        originalConnect,
        target,
        args,
      ) as Promise<PoolClient>;
      return promise.then((client) => {
        const clientQuery = client.query.bind(client) as PgQuery;
        client.query = instrumentQuery(
          client,
          clientQuery,
        ) as PoolClient["query"];
        return client;
      });
    } as Pool["connect"];

    return target;
  }

  return instrumentPool(
    new Pool({
      allowExitOnIdle: true,
      connectionString: env("DATABASE_URL"),
      min: 1,
      max: 5,
    }),
  );
});

export const db = singleton((): NodePgDatabase<typeof schema> => {
  return drizzle(pool(), { schema });
});

export async function closeDbPool(): Promise<void> {
  const current = pool.peek();
  if (current) {
    await current.end();
    pool.reset();
    db.reset();
  }
}
