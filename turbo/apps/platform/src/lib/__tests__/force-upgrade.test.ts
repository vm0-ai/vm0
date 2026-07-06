import { describe, expect, it, vi } from "vitest";

import {
  buildForceUpgradeUrl,
  checkForceUpgrade,
  shouldForceUpgrade,
} from "../force-upgrade.ts";

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: vi.fn(() => {
      return Promise.resolve(body);
    }),
  };
}

describe("force upgrade", () => {
  it("builds the Atom force-upgrade URL with the current version", () => {
    expect(
      buildForceUpgradeUrl("0.540.0", "https://atom-api.vm6.ai/"),
    ).toBe("https://atom-api.vm6.ai/api/client/force-upgrade?version=0.540.0");
  });

  it("returns true only when Atom explicitly requires a force upgrade", async () => {
    const fetcher = vi.fn(() => {
      return Promise.resolve(jsonResponse({ forceUpgrade: true }));
    });

    await expect(
      shouldForceUpgrade("0.540.0", {
        apiBase: "https://atom-api.vm6.ai",
        fetcher,
      }),
    ).resolves.toBeTruthy();

    expect(fetcher).toHaveBeenCalledWith(
      "https://atom-api.vm6.ai/api/client/force-upgrade?version=0.540.0",
      {
        cache: "no-store",
        credentials: "omit",
        method: "GET",
      },
    );
  });

  it("returns false when Atom does not require a force upgrade", async () => {
    await expect(
      checkForceUpgrade({
        fetcher: vi.fn(() => {
          return Promise.resolve(jsonResponse({ forceUpgrade: false }));
        }),
        version: "0.540.0",
      }),
    ).resolves.toBeFalsy();
  });

  it("returns true when Atom requires a force upgrade", async () => {
    await expect(
      checkForceUpgrade({
        fetcher: vi.fn(() => {
          return Promise.resolve(jsonResponse({ forceUpgrade: true }));
        }),
        version: "0.540.0",
      }),
    ).resolves.toBeTruthy();
  });

  it("returns false when the response is not OK", async () => {
    await expect(
      checkForceUpgrade({
        fetcher: vi.fn(() => {
          return Promise.resolve(jsonResponse({ forceUpgrade: true }, false));
        }),
        version: "0.540.0",
      }),
    ).resolves.toBeFalsy();
  });

  it("skips the request when the build version is unavailable", async () => {
    const fetcher = vi.fn(() => {
      return Promise.resolve(jsonResponse({ forceUpgrade: true }));
    });

    await expect(
      checkForceUpgrade({
        fetcher,
        version: null,
      }),
    ).resolves.toBeFalsy();

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns false when the force-upgrade request fails", async () => {
    await expect(
      checkForceUpgrade({
        fetcher: vi.fn(() => {
          return Promise.reject(new Error("network unavailable"));
        }),
        version: "0.540.0",
      }),
    ).resolves.toBeFalsy();
  });
});
