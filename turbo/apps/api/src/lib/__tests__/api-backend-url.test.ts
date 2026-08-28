import { describe, expect, it } from "vitest";

import { apiBackendUrl } from "../api-backend-url";
import { mockEnv, mockOptionalEnv } from "../env";
import { getOAuthApiOrigin } from "../oauth-origin";

const CANONICAL_API_BACKEND_URL_KEY = "OKOU_API_BACKEND_URL";
const LEGACY_API_BACKEND_URL_KEY = "VM0_API_BACKEND_URL";

function configureApiBackendUrl(value: string | undefined): void {
  mockEnv(CANONICAL_API_BACKEND_URL_KEY, value);
}

describe("API backend URL", () => {
  it("returns the canonical URL byte-for-byte", () => {
    const value =
      "https://canonical-only.example.test/path?query=preserved#fragment";
    configureApiBackendUrl(value);

    expect(apiBackendUrl()).toBe(value);
  });

  it("returns undefined when the canonical input is absent", () => {
    configureApiBackendUrl(undefined);

    expect(apiBackendUrl()).toBeUndefined();
  });

  it.each(["", "not-a-url"])("rejects invalid canonical input %j", (value) => {
    expect(() => {
      configureApiBackendUrl(value);
    }).toThrow(/Invalid URL/u);
  });

  it("ignores a retired legacy-only input", () => {
    configureApiBackendUrl(undefined);
    mockOptionalEnv(
      LEGACY_API_BACKEND_URL_KEY,
      "https://legacy-only.example.test/path",
    );

    expect(apiBackendUrl()).toBeUndefined();
  });

  it("does not let a retired legacy value override or conflict with canonical", () => {
    const canonical = "https://canonical.example.test/path";
    configureApiBackendUrl(canonical);
    mockOptionalEnv(
      LEGACY_API_BACKEND_URL_KEY,
      "https://legacy.example.test/path",
    );

    expect(() => {
      apiBackendUrl();
    }).not.toThrow();
    expect(apiBackendUrl()).toBe(canonical);
  });
});

describe("OAuth API origin", () => {
  it("keeps OAuth configured-origin normalization and sibling/web fallbacks", () => {
    const request = new Request("https://request.example.test/oauth");
    configureApiBackendUrl("https://api.vm0.ai/configured/path");
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    expect(getOAuthApiOrigin(request)).toBe("https://api.vm0.ai");

    configureApiBackendUrl(undefined);
    mockEnv("VM0_WEB_URL", "https://www.vm6.ai");
    expect(getOAuthApiOrigin(request)).toBe("https://api.vm6.ai");

    mockEnv("VM0_WEB_URL", "https://external.example.test/path");
    expect(getOAuthApiOrigin(request)).toBe("https://external.example.test");
  });
});
