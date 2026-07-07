import { describe, expect, it } from "vitest";

import {
  appVersionSchema,
  webClientCompatibilityContract,
  webClientCompatibilityQuerySchema,
  webClientCompatibilityResponseSchema,
} from "../web-client-compatibility";

describe("web client compatibility contract", () => {
  it("defines the web client compatibility endpoint", () => {
    expect(webClientCompatibilityContract.get.method).toBe("GET");
    expect(webClientCompatibilityContract.get.path).toBe(
      "/api/client/compatibility",
    );
  });

  it("accepts app-style versions", () => {
    expect(appVersionSchema.parse("1.229.0")).toBe("1.229.0");
    expect(appVersionSchema.parse("1.229.0-beta.1")).toBe("1.229.0-beta.1");
    expect(appVersionSchema.parse("1.229.0+build.1")).toBe("1.229.0+build.1");
  });

  it("rejects malformed app versions", () => {
    expect(appVersionSchema.safeParse("").success).toBe(false);
    expect(appVersionSchema.safeParse("v1.229.0").success).toBe(false);
    expect(appVersionSchema.safeParse("1.229").success).toBe(false);
  });

  it("validates query and response bodies", () => {
    expect(
      webClientCompatibilityQuerySchema.parse({ version: "1.229.0" }),
    ).toStrictEqual({ version: "1.229.0" });
    expect(
      webClientCompatibilityResponseSchema.parse({
        minimumSupportedVersion: "1.229.0",
        supported: true,
      }),
    ).toStrictEqual({
      minimumSupportedVersion: "1.229.0",
      supported: true,
    });
  });
});
