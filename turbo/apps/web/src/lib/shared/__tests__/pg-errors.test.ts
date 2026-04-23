import { describe, it, expect } from "vitest";
import { isForeignKeyViolation } from "../pg-errors";

describe("isForeignKeyViolation", () => {
  it("returns true for drizzle-wrapped PG error with cause.code 23503", () => {
    // Shape drizzle actually produces at runtime — DrizzleQueryError wraps
    // the underlying postgres driver error as `.cause`, which exposes
    // SQLSTATE on `.code`. This is the shape observed in production
    // Sentry reports for #10725.
    const pgError = Object.assign(new Error("foreign_key_violation"), {
      code: "23503",
    });
    const wrapped = new Error("Failed query: insert into ...", {
      cause: pgError,
    });
    expect(isForeignKeyViolation(wrapped)).toBe(true);
  });

  it("returns true for a plain Error whose cause is an object with code 23503", () => {
    const err = new Error("wrapped", { cause: { code: "23503" } });
    expect(isForeignKeyViolation(err)).toBe(true);
  });

  it("returns false when cause.code is a different SQLSTATE", () => {
    // 23505 = unique_violation. Common sibling of 23503; must not be
    // conflated — unique violations shouldn't 404 the caller.
    const err = new Error("wrapped", { cause: { code: "23505" } });
    expect(isForeignKeyViolation(err)).toBe(false);
  });

  it("returns false when cause is missing", () => {
    expect(isForeignKeyViolation(new Error("no cause"))).toBe(false);
  });

  it("returns false when cause is not an object", () => {
    const err = new Error("string cause", { cause: "23503" });
    expect(isForeignKeyViolation(err)).toBe(false);
  });

  it("returns false when cause is null", () => {
    const err = new Error("null cause", { cause: null });
    expect(isForeignKeyViolation(err)).toBe(false);
  });

  it("returns false when cause.code is missing", () => {
    const err = new Error("no code", { cause: { detail: "something" } });
    expect(isForeignKeyViolation(err)).toBe(false);
  });

  it("returns false for non-Error inputs", () => {
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
    expect(isForeignKeyViolation("23503")).toBe(false);
    expect(isForeignKeyViolation({ code: "23503" })).toBe(false);
  });
});
