import { describe, it, expect, vi, afterEach } from "vitest";
import { getPlatformUrl } from "../url";

describe("getPlatformUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns PLATFORM_URL env var", () => {
    vi.stubEnv("PLATFORM_URL", "https://platform.vm0.ai");

    expect(getPlatformUrl()).toBe("https://platform.vm0.ai");
  });
});
