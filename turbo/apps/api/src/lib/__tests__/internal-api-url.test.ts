import { describe, expect, it } from "vitest";

import { mockEnv } from "../env";
import { internalApiBaseUrl } from "../internal-api-url";

// Mocked env is reset after each test by the shared test setup
// (src/__tests__/setup.ts calls clearMockedEnv in afterEach).
describe("internalApiBaseUrl", () => {
  it("uses VM0_INTERNAL_API_URL when set so internal callbacks skip www", () => {
    mockEnv("VM0_API_URL", "https://www.vm0.ai");
    mockEnv("VM0_INTERNAL_API_URL", "https://api.vm0.ai");

    expect(internalApiBaseUrl()).toBe("https://api.vm0.ai");
    expect(
      new URL("/api/internal/callbacks/chat", internalApiBaseUrl()).toString(),
    ).toBe("https://api.vm0.ai/api/internal/callbacks/chat");
  });

  it("falls back to VM0_API_URL when VM0_INTERNAL_API_URL is unset", () => {
    mockEnv("VM0_API_URL", "https://www.vm0.ai");

    expect(internalApiBaseUrl()).toBe("https://www.vm0.ai");
  });

  it("falls back to a dev tunnel VM0_API_URL when unset", () => {
    mockEnv("VM0_API_URL", "https://tunnel-abc.vm0.dev");

    expect(internalApiBaseUrl()).toBe("https://tunnel-abc.vm0.dev");
  });
});
