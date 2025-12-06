import { test, expect, describe } from "vitest";

describe("CLI Tests", () => {
  test("should run in test environment", () => {
    expect(typeof process.version).toBe("string");
  });
});
