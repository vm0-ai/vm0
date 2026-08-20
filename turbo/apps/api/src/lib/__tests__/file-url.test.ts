import { describe, expect, it } from "vitest";

import { mockEnv } from "../env";
import {
  buildFileUrlFromKey,
  publicBrandFromArtifactUrl,
} from "../file-url";

describe("branded artifact URLs", () => {
  it("maps each configured CDN origin to its public brand", () => {
    mockEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm0.test");
    mockEnv("OKOU_PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.okou.test");

    const vm0Url = buildFileUrlFromKey("artifacts/example.png", "vm0");
    const okouUrl = buildFileUrlFromKey("artifacts/example.png", "okou");

    expect(vm0Url).toBe("https://cdn.vm0.test/artifacts/example.png");
    expect(okouUrl).toBe("https://cdn.okou.test/artifacts/example.png");
    expect(publicBrandFromArtifactUrl(vm0Url)).toBe("vm0");
    expect(publicBrandFromArtifactUrl(okouUrl)).toBe("okou");
  });

  it("keeps fallback URLs classified as VM0 before Okou config rolls out", () => {
    mockEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm0.test");
    mockEnv("OKOU_PUBLIC_ARTIFACTS_BASE_URL", undefined);

    const fallbackUrl = buildFileUrlFromKey("artifacts/example.png", "okou");

    expect(fallbackUrl).toBe("https://cdn.vm0.test/artifacts/example.png");
    expect(publicBrandFromArtifactUrl(fallbackUrl)).toBe("vm0");
  });
});
