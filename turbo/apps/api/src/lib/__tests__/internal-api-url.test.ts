import { describe, expect, it } from "vitest";

import { mockEnv } from "../env";
import { internalApiBaseUrl } from "../internal-api-url";

// Mocked env is reset after each test by the shared test setup
// (src/__tests__/setup.ts calls clearMockedEnv in afterEach).
describe("internalApiBaseUrl", () => {
  it("uses VM0_API_BACKEND_URL when set so internal callbacks skip www", () => {
    mockEnv("VM0_API_URL", "https://www.vm0.ai");
    mockEnv("VM0_API_BACKEND_URL", "https://api.vm0.ai");

    expect(internalApiBaseUrl()).toBe("https://api.vm0.ai");
    expect(
      new URL("/api/internal/callbacks/chat", internalApiBaseUrl()).toString(),
    ).toBe("https://api.vm0.ai/api/internal/callbacks/chat");
  });

  it("defaults to the API backend origin in production when VM0_API_BACKEND_URL is unset", () => {
    mockEnv("ENV", "production");
    mockEnv("VM0_API_URL", "https://www.vm0.ai");
    mockEnv("VM0_API_BACKEND_URL", undefined);

    expect(internalApiBaseUrl()).toBe("https://vm0-api.vm6.ai");
  });

  it("falls back to VM0_API_URL outside production when VM0_API_BACKEND_URL is unset", () => {
    mockEnv("ENV", "development");
    mockEnv("VM0_API_URL", "https://tunnel-abc.vm0.dev");
    mockEnv("VM0_API_BACKEND_URL", undefined);

    expect(internalApiBaseUrl()).toBe("https://tunnel-abc.vm0.dev");
  });
});
