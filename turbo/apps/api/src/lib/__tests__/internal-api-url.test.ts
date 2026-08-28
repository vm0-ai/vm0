import { describe, expect, it } from "vitest";

import { mockEnv } from "../env";
import { internalApiBaseUrl } from "../internal-api-url";

// Mocked env is reset after each test by the shared test setup
// (src/__tests__/setup.ts calls clearMockedEnv in afterEach).
describe("internalApiBaseUrl", () => {
  it("uses OKOU_API_BACKEND_URL when set so internal API calls skip www", () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");

    expect(internalApiBaseUrl()).toBe("https://api.vm0.ai");
    expect(
      new URL(
        "/api/cron/aggregate-model-stats",
        internalApiBaseUrl(),
      ).toString(),
    ).toBe("https://api.vm0.ai/api/cron/aggregate-model-stats");
  });

  it("defaults to the API backend origin in production when the backend URL is unset", () => {
    mockEnv("ENV", "production");
    mockEnv("OKOU_API_BACKEND_URL", undefined);
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");

    expect(internalApiBaseUrl()).toBe("https://vm0-api.vm6.ai");
  });

  it("falls back to VM0_WEB_URL outside production when the backend URL is unset", () => {
    mockEnv("ENV", "development");
    mockEnv("OKOU_API_BACKEND_URL", undefined);
    mockEnv("VM0_WEB_URL", "https://tunnel-abc.vm0.dev");

    expect(internalApiBaseUrl()).toBe("https://tunnel-abc.vm0.dev");
  });
});
