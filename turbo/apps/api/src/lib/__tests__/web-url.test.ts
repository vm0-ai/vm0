import { createHash } from "node:crypto";

import { EVENT } from "@axiomhq/logging";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubTestWebUrlEnvironment } from "../../__tests__/env-stub";
import { testContext } from "../../__tests__/test-context";
import { mockEnv } from "../env";
import {
  getOAuthApiOrigin,
  getOAuthCanonicalRedirectUrl,
  getOAuthWebOrigin,
} from "../oauth-origin";
import { webUrl } from "../web-url";

const context = testContext();

const CANONICAL_WEB_URL_KEY = "OKOU_WEB_URL";
const LEGACY_WEB_URL_KEY = "VM0_WEB_URL";
const WEB_URL_ALIAS_RESOLUTION_EVENT = "web_url_alias_resolution";
const WEB_URL_LOG_CONTEXT = "WebUrl";
const WEB_URL_MISSING_ERROR =
  "Web URL aliases are missing: canonicalKey=OKOU_WEB_URL legacyKey=VM0_WEB_URL state=absent";
const WEB_URL_CONFLICT_ERROR =
  "Web URL aliases conflict: canonicalKey=OKOU_WEB_URL legacyKey=VM0_WEB_URL state=conflicting-dual";

type WebUrlKey = typeof CANONICAL_WEB_URL_KEY | typeof LEGACY_WEB_URL_KEY;
type NonConflictingWebUrlAliasState =
  | "canonical-only"
  | "legacy-only"
  | "equal-dual";

interface WebUrlAliasFixture {
  readonly state: NonConflictingWebUrlAliasState;
  readonly canonical: string | undefined;
  readonly legacy: string | undefined;
  readonly expected: string;
}

const canonicalOnlyUrl = `https://canonical-only.example.test/${"c".repeat(
  113,
)}`;
const legacyOnlyUrl = `https://legacy-only.example.test/${"l".repeat(127)}`;
const equalDualUrl = `https://equal-dual.example.test/${"e".repeat(131)}`;

const WEB_URL_ALIAS_FIXTURES: readonly WebUrlAliasFixture[] = [
  {
    state: "canonical-only",
    canonical: canonicalOnlyUrl,
    legacy: undefined,
    expected: canonicalOnlyUrl,
  },
  {
    state: "legacy-only",
    canonical: undefined,
    legacy: legacyOnlyUrl,
    expected: legacyOnlyUrl,
  },
  {
    state: "equal-dual",
    canonical: equalDualUrl,
    legacy: equalDualUrl,
    expected: equalDualUrl,
  },
];

const INVALID_WEB_URL_FIXTURES: readonly {
  readonly key: WebUrlKey;
  readonly value: string;
}[] = [
  { key: CANONICAL_WEB_URL_KEY, value: "" },
  { key: CANONICAL_WEB_URL_KEY, value: "not-a-url" },
  { key: LEGACY_WEB_URL_KEY, value: "" },
  { key: LEGACY_WEB_URL_KEY, value: "not-a-url" },
];

function configureAliases(
  canonical: string | undefined,
  legacy: string | undefined,
): void {
  mockEnv(CANONICAL_WEB_URL_KEY, canonical);
  mockEnv(LEGACY_WEB_URL_KEY, legacy);
}

async function importEnvWithRawWebAliases(
  canonical: string | undefined,
  legacy: string | undefined,
): Promise<void> {
  // Environment validation happens during module initialization, so reloading
  // the module is the production boundary for exercising raw process input.
  vi.resetModules();
  stubTestWebUrlEnvironment(canonical, legacy);
  await import("../env");
}

function aliasEvidence(state: string): Readonly<Record<string, unknown>> {
  return {
    [EVENT]: { source: "api" },
    canonicalKey: CANONICAL_WEB_URL_KEY,
    legacyKey: LEGACY_WEB_URL_KEY,
    state,
    context: WEB_URL_LOG_CONTEXT,
  };
}

function expectValueFree(diagnostics: string, values: readonly string[]): void {
  for (const value of values) {
    const forbiddenDerivatives = [
      value,
      String(value.length),
      createHash("sha256").update(value).digest("hex"),
      JSON.stringify(value),
    ];
    for (const derivative of forbiddenDerivatives) {
      expect(diagnostics).not.toContain(derivative);
    }
  }
}

describe("web URL aliases", () => {
  afterEach(() => {
    stubTestWebUrlEnvironment(undefined, "http://localhost:3001");
    vi.resetModules();
  });

  it("resolves the non-conflicting matrix with one value-free event per state", () => {
    for (const fixture of WEB_URL_ALIAS_FIXTURES) {
      configureAliases(fixture.canonical, fixture.legacy);
      const logCount = context.mocks.axiomLogging.info.mock.calls.length;

      expect(webUrl()).toBe(fixture.expected);
      expect(webUrl()).toBe(fixture.expected);

      const calls = context.mocks.axiomLogging.info.mock.calls.slice(logCount);
      expect(calls).toStrictEqual([
        [WEB_URL_ALIAS_RESOLUTION_EVENT, aliasEvidence(fixture.state)],
      ]);
      expectValueFree(
        JSON.stringify(calls),
        [fixture.canonical, fixture.legacy].filter((value): value is string => {
          return value !== undefined;
        }),
      );
    }
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.warn).not.toHaveBeenCalled();
  });

  it("fails closed when the required aliases are both absent", () => {
    configureAliases(undefined, undefined);
    mockEnv("APP_URL", "https://app-fallback.example.test");
    const request = new Request("https://request.example.test/oauth");

    expect(() => {
      getOAuthWebOrigin(request);
    }).toThrow(WEB_URL_MISSING_ERROR);
    expect(() => {
      getOAuthWebOrigin(request);
    }).toThrow(WEB_URL_MISSING_ERROR);

    expect(context.mocks.axiomLogging.warn.mock.calls).toStrictEqual([
      [WEB_URL_ALIAS_RESOLUTION_EVENT, aliasEvidence("absent")],
    ]);
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.info).not.toHaveBeenCalled();
  });

  it("fails before OAuth origin normalization on byte-unequal aliases", () => {
    const canonical = "https://same-origin.example.test";
    const legacy = "https://same-origin.example.test/";
    configureAliases(canonical, legacy);
    mockEnv("APP_URL", "https://app-fallback.example.test");
    const request = new Request("https://request.example.test/oauth");

    expect(new URL(canonical).origin).toBe(new URL(legacy).origin);
    expect(() => {
      getOAuthWebOrigin(request);
    }).toThrow(WEB_URL_CONFLICT_ERROR);
    expect(() => {
      getOAuthWebOrigin(request);
    }).toThrow(WEB_URL_CONFLICT_ERROR);

    expect(context.mocks.axiomLogging.warn.mock.calls).toStrictEqual([
      [WEB_URL_ALIAS_RESOLUTION_EVENT, aliasEvidence("conflicting-dual")],
    ]);
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.info).not.toHaveBeenCalled();
    expectValueFree(
      JSON.stringify({
        error: WEB_URL_CONFLICT_ERROR,
        logs: context.mocks.axiomLogging.warn.mock.calls,
      }),
      [canonical, legacy],
    );
  });

  it.each(INVALID_WEB_URL_FIXTURES)(
    "rejects invalid $key input before alias resolution",
    ({ key, value }) => {
      expect(() => {
        mockEnv(key, value);
      }).toThrow(/Invalid URL/u);
    },
  );

  it.each([
    {
      key: CANONICAL_WEB_URL_KEY,
      canonical: "",
      legacy: "https://legacy-sibling.example.test",
    },
    {
      key: LEGACY_WEB_URL_KEY,
      canonical: "https://canonical-sibling.example.test",
      legacy: "",
    },
  ])(
    "rejects empty raw $key input before sibling fallback",
    async ({ canonical, legacy }) => {
      await expect(
        importEnvWithRawWebAliases(canonical, legacy),
      ).rejects.toThrow(/Invalid URL/u);
    },
  );

  it("preserves OAuth web, API, and canonical redirect origins for legacy-only input", () => {
    configureAliases(undefined, "https://www.vm6.ai/configured/path");
    mockEnv("OKOU_API_BACKEND_URL", undefined);
    const request = new Request(
      "https://api.vm6.ai/api/connectors/github/callback?code=test",
    );

    expect(getOAuthWebOrigin(request)).toBe("https://www.vm6.ai");
    expect(getOAuthApiOrigin(request)).toBe("https://api.vm6.ai");
    expect(getOAuthCanonicalRedirectUrl(request)).toBe(
      "https://www.vm6.ai/api/connectors/github/callback?code=test",
    );
  });
});
