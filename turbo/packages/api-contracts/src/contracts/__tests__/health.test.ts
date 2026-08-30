import { describe, expect, it } from "vitest";

import { healthContract, healthResponseSchema } from "../health";

describe("health contract", () => {
  it("defines the API health endpoint", () => {
    expect(healthContract.check.method).toBe("GET");
    expect(healthContract.check.path).toBe("/health");
  });

  it("accepts the health response body", () => {
    expect(healthResponseSchema.parse({ status: "ok" })).toEqual({
      status: "ok",
    });
  });
});
