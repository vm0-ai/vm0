import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("env", () => {
  const originalEnv = { ...import.meta.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.assign(import.meta.env, originalEnv);
  });

  it("should export env config with correct types", async () => {
    const { env } = await import("../env");

    expect(env).toHaveProperty("MODE");
    expect(env).toHaveProperty("DEV");
    expect(env).toHaveProperty("PROD");
    expect(typeof env.DEV).toBe("boolean");
    expect(typeof env.PROD).toBe("boolean");
  });

  it("should handle missing optional vars", async () => {
    delete import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
    delete import.meta.env.VITE_API_URL;

    const { env } = await import("../env");

    // Missing vars should be undefined, not throw
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.VITE_API_URL).toBeUndefined();
  });

  it("should read VITE_ prefixed variables", async () => {
    import.meta.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_123";
    import.meta.env.VITE_API_URL = "https://api.example.com";

    const { env } = await import("../env");

    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBe("pk_test_123");
    expect(env.VITE_API_URL).toBe("https://api.example.com");
  });
});
