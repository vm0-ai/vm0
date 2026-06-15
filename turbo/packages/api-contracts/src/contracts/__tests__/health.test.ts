import { describe, expect, it } from "vitest";

import {
  healthAuthContract,
  healthContract,
  healthResponseSchema,
} from "../health";

describe("health contract", () => {
  it("defines the API health endpoint", () => {
    expect(healthContract.check.method).toBe("GET");
    expect(healthContract.check.path).toBe("/health");
  });

  it("defines the authenticated API health endpoint", () => {
    expect(healthAuthContract.check.method).toBe("GET");
    expect(healthAuthContract.check.path).toBe("/health/auth");
    expect(healthAuthContract.check.responses[401]).toBeDefined();
  });

  it("accepts the health response body", () => {
    expect(healthResponseSchema.parse({ status: "ok" })).toEqual({
      status: "ok",
    });
  });
});
