import { describe, it, expect, vi } from "vitest";
import { reloadEnv } from "../../env";

describe("getPlatformUrl", () => {
  it("returns NEXT_PUBLIC_PLATFORM_URL env var", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "https://platform.vm0.ai");
    reloadEnv();

    const { getPlatformUrl } = await import("../url");
    expect(getPlatformUrl()).toBe("https://platform.vm0.ai");
  });
});
