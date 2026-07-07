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
  it("builds the web client compatibility URL with the current version", () => {
    expect(buildForceUpgradeUrl("0.540.0", "https://api.example.test/")).toBe(
      "https://api.example.test/api/client/compatibility?version=0.540.0",
    );
  });

  it("returns true only when the API marks the client unsupported", async () => {
    const fetcher = vi.fn(() => {
      return Promise.resolve(jsonResponse({ supported: false }));
    });

    await expect(
      shouldForceUpgrade("0.540.0", {
        apiBase: "https://api.example.test",
        fetcher,
      }),
    ).resolves.toBeTruthy();

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/api/client/compatibility?version=0.540.0",
      {
        cache: "no-store",
        credentials: "omit",
        method: "GET",
      },
    );
  });

  it("returns false when the API marks the client supported", async () => {
    await expect(
      checkForceUpgrade({
        apiBase: "https://api.example.test",
        fetcher: vi.fn(() => {
          return Promise.resolve(jsonResponse({ supported: true }));
        }),
        version: "0.540.0",
      }),
    ).resolves.toBeFalsy();
  });

  it("returns true when the API marks the client unsupported", async () => {
    await expect(
      checkForceUpgrade({
        apiBase: "https://api.example.test",
        fetcher: vi.fn(() => {
          return Promise.resolve(jsonResponse({ supported: false }));
        }),
        version: "0.540.0",
      }),
    ).resolves.toBeTruthy();
  });

  it("returns false when the response is not OK", async () => {
    await expect(
      checkForceUpgrade({
        apiBase: "https://api.example.test",
        fetcher: vi.fn(() => {
          return Promise.resolve(jsonResponse({ supported: false }, false));
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
        apiBase: "https://api.example.test",
        fetcher: vi.fn(() => {
          return Promise.reject(new Error("network unavailable"));
        }),
        version: "0.540.0",
      }),
    ).resolves.toBeFalsy();
  });
});
