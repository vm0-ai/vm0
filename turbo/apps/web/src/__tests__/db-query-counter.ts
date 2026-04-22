import type { Pool } from "pg";

interface QueryCounter {
  countMatching(pattern: RegExp): number;
  restore(): void;
}

/**
 * Wrap `globalThis.services.pool.query` to count SQL statements issued during
 * a test, so integration tests can assert that duplicate reads have been
 * deduplicated at the pool level (independent of which code path issued the
 * SELECT). Tests run against pg; Neon serverless is prod-only.
 *
 * Two `as` coercions live at the monkey-patch boundary because `pool.query`
 * is an overloaded function and a plain variadic wrapper is only assignable
 * to it via cast. The first-arg text extraction uses structural `typeof` +
 * `in` narrowing rather than casts, so no `any` / `eslint-disable` is needed.
 */
export function createQueryCounter(): QueryCounter {
  const pool: Pool = globalThis.services.pool;
  const original = pool.query.bind(pool);
  const calls: string[] = [];
  const wrapped = ((...args: unknown[]): unknown => {
    const first = args[0];
    let text = "";
    if (typeof first === "string") {
      text = first;
    } else if (
      typeof first === "object" &&
      first !== null &&
      "text" in first &&
      typeof first.text === "string"
    ) {
      text = first.text;
    }
    calls.push(text);
    return (original as (...rest: unknown[]) => unknown)(...args);
  }) as typeof pool.query;
  pool.query = wrapped;
  return {
    countMatching: (p) => {
      return calls.filter((c) => {
        return p.test(c);
      }).length;
    },
    restore: () => {
      pool.query = original as typeof pool.query;
    },
  };
}
