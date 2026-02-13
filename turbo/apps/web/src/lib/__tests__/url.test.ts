import { describe, it, expect, vi } from "vitest";
import { reloadEnv } from "../../env";
import { getPlatformUrl } from "../url";

describe("getPlatformUrl", () => {
  it("returns NEXT_PUBLIC_PLATFORM_URL env var", () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_URL", "https://platform.vm0.ai");
    reloadEnv();

    expect(getPlatformUrl()).toBe("https://platform.vm0.ai");
  });
});
