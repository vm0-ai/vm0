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

  it("should allow missing optional vars in development", async () => {
    import.meta.env.DEV = true;
    import.meta.env.PROD = false;
    delete import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
    delete import.meta.env.VITE_API_URL;

    const { env } = await import("../env");

    // In development, missing vars should not throw
    expect(env.DEV).toBe(true);
    expect(env.PROD).toBe(false);
  });

  it("should read VITE_ prefixed variables", async () => {
    import.meta.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_123";
    import.meta.env.VITE_API_URL = "https://api.example.com";

    const { env } = await import("../env");

    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBe("pk_test_123");
    expect(env.VITE_API_URL).toBe("https://api.example.com");
  });
});
