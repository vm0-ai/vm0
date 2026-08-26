import { describe, expect, it } from "vitest";

import { resolveImmutableDedupeInsert } from "../immutable-dedupe-insert";

function postgresError(code: string): Error {
  return new Error(`PostgreSQL error ${code}`, { cause: { code } });
}

describe("resolveImmutableDedupeInsert", () => {
  it("returns the row created by a successful insert", () => {
    const row = { id: "created-row" };

    expect(resolveImmutableDedupeInsert({ ok: true, value: [row] })).toBe(row);
  });

  it("maps an exact PostgreSQL 23505 to the duplicate result", () => {
    expect(
      resolveImmutableDedupeInsert({
        ok: false,
        error: postgresError("23505"),
      }),
    ).toBeNull();
  });

  it.each([
    ["foreign-key violation", postgresError("23503")],
    ["check violation", postgresError("23514")],
    ["connection failure", postgresError("ECONNRESET")],
    ["abort", new DOMException("aborted", "AbortError")],
    ["arbitrary error", new Error("arbitrary failure")],
  ])("rethrows a %s unchanged", (_label, error) => {
    expect(() => {
      resolveImmutableDedupeInsert({ ok: false, error });
    }).toThrow(error);
  });
});
