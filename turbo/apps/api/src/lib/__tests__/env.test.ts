import { afterEach, describe, expect, it } from "vitest";
import { env, mockEnv, clearMockedEnv } from "../env";

describe("env", () => {
  afterEach(() => {
    clearMockedEnv();
  });

  it("returns environment variables from the base schema", () => {
    expect(env("ENV")).toBe("development");
    expect(env("VM0_API_URL")).toBe("http://localhost:3000");
    expect(env("GIT_COMMIT_SHA")).toBe("test-commit-sha");
  });

  it("returns overridden value after mockEnv", () => {
    mockEnv("ENV", "production");
    expect(env("ENV")).toBe("production");
  });

  it("restores original value after clearMockedEnv", () => {
    mockEnv("ENV", "production");
    expect(env("ENV")).toBe("production");

    clearMockedEnv();
    expect(env("ENV")).toBe("development");
  });

  it("supports multiple overrides", () => {
    mockEnv("ENV", "preview");
    mockEnv("VM0_API_URL", "https://example.com");

    expect(env("ENV")).toBe("preview");
    expect(env("VM0_API_URL")).toBe("https://example.com");
    // Un-mocked key still returns the base value
    expect(env("VM0_WEB_URL")).toBe("http://localhost:3001");
  });

  it("rejects invalid mockEnv values with Zod validation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => {
      (mockEnv as any)("ENV", "invalid_env_value");
    }).toThrow();
  });

  it("applies partial overrides without affecting other keys", () => {
    mockEnv("ENV", "production");

    // Other keys remain unchanged
    expect(env("VM0_API_URL")).toBe("http://localhost:3000");
    expect(env("R2_USER_STORAGES_BUCKET_NAME")).toBe("test-user-storages");
    expect(env("ENV")).toBe("production");
  });

  it("clearMockedEnv is idempotent", () => {
    clearMockedEnv();
    clearMockedEnv();

    expect(env("ENV")).toBe("development");
  });
});
