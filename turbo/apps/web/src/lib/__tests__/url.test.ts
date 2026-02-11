import { describe, it, expect, vi } from "vitest";
import { reloadEnv } from "../../env";

describe("getPlatformUrl", () => {
  it("returns PLATFORM_URL env var", async () => {
    vi.stubEnv("PLATFORM_URL", "https://platform.vm0.ai");
    reloadEnv();

    const { getPlatformUrl } = await import("../url");
    expect(getPlatformUrl()).toBe("https://platform.vm0.ai");
  });
});
