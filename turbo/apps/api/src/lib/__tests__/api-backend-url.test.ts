import { createHash } from "node:crypto";

import { EVENT } from "@axiomhq/logging";
import { describe, expect, it } from "vitest";

import { testContext } from "../../__tests__/test-context";
import { apiBackendUrl } from "../api-backend-url";
import { mockEnv } from "../env";
import { getOAuthApiOrigin } from "../oauth-origin";

const context = testContext();

const CANONICAL_API_BACKEND_URL_KEY = "OKOU_API_BACKEND_URL";
const LEGACY_API_BACKEND_URL_KEY = "VM0_API_BACKEND_URL";
const API_BACKEND_URL_ALIAS_RESOLUTION_EVENT =
  "api_backend_url_alias_resolution";
const API_BACKEND_URL_LOG_CONTEXT = "ApiBackendUrl";

type ApiBackendUrlAliasState =
  | "absent"
  | "canonical-only"
  | "legacy-only"
  | "equal-dual";

interface ApiBackendUrlAliasFixture {
  readonly state: ApiBackendUrlAliasState;
  readonly canonical: string | undefined;
  readonly legacy: string | undefined;
  readonly expected: string | undefined;
}

const API_BACKEND_URL_ALIAS_FIXTURES: readonly ApiBackendUrlAliasFixture[] = [
  {
    state: "absent",
    canonical: undefined,
    legacy: undefined,
    expected: undefined,
  },
  {
    state: "canonical-only",
    canonical: "https://canonical-only.example.test",
    legacy: undefined,
    expected: "https://canonical-only.example.test",
  },
  {
    state: "legacy-only",
    canonical: undefined,
    legacy: "https://legacy-only.example.test",
    expected: "https://legacy-only.example.test",
  },
  {
    state: "equal-dual",
    canonical: "https://equal-dual.example.test",
    legacy: "https://equal-dual.example.test",
    expected: "https://equal-dual.example.test",
  },
];

function configureAliases(
  canonical: string | undefined,
  legacy: string | undefined,
): void {
  mockEnv(CANONICAL_API_BACKEND_URL_KEY, canonical);
  mockEnv(LEGACY_API_BACKEND_URL_KEY, legacy);
}

function aliasEvidence(state: string): Readonly<Record<string, unknown>> {
  return {
    [EVENT]: { source: "api" },
    canonicalKey: CANONICAL_API_BACKEND_URL_KEY,
    legacyKey: LEGACY_API_BACKEND_URL_KEY,
    state,
    context: API_BACKEND_URL_LOG_CONTEXT,
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

describe("API backend URL aliases", () => {
  it("resolves the non-conflicting matrix with one value-free event per state", () => {
    for (const fixture of API_BACKEND_URL_ALIAS_FIXTURES) {
      configureAliases(fixture.canonical, fixture.legacy);
      const logCount = context.mocks.axiomLogging.info.mock.calls.length;

      expect(apiBackendUrl()).toBe(fixture.expected);
      expect(apiBackendUrl()).toBe(fixture.expected);

      const calls = context.mocks.axiomLogging.info.mock.calls.slice(logCount);
      expect(calls).toStrictEqual([
        [API_BACKEND_URL_ALIAS_RESOLUTION_EVENT, aliasEvidence(fixture.state)],
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

  it("fails closed on conflicting aliases with bounded value-free diagnostics", () => {
    const canonical = "https://canonical-url-must-not-leak.example.test";
    const legacy = "https://legacy-url-must-not-leak.example.test";
    const expectedMessage =
      "API backend URL aliases conflict: canonicalKey=OKOU_API_BACKEND_URL legacyKey=VM0_API_BACKEND_URL state=conflicting-dual";
    configureAliases(canonical, legacy);

    expect(() => {
      apiBackendUrl();
    }).toThrow(expectedMessage);
    expect(() => {
      apiBackendUrl();
    }).toThrow(expectedMessage);

    expect(context.mocks.axiomLogging.warn.mock.calls).toStrictEqual([
      [
        API_BACKEND_URL_ALIAS_RESOLUTION_EVENT,
        aliasEvidence("conflicting-dual"),
      ],
    ]);
    const diagnostics = JSON.stringify({
      error: expectedMessage,
      logs: context.mocks.axiomLogging.warn.mock.calls,
    });
    expect(diagnostics).not.toContain(canonical);
    expect(diagnostics).not.toContain(legacy);
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.info).not.toHaveBeenCalled();
  });
});

describe("OAuth API origin", () => {
  it("keeps OAuth configured-origin normalization and sibling/web fallbacks", () => {
    const request = new Request("https://request.example.test/oauth");
    configureAliases("https://api.vm0.ai/configured/path", undefined);
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    expect(getOAuthApiOrigin(request)).toBe("https://api.vm0.ai");

    configureAliases(undefined, undefined);
    mockEnv("VM0_WEB_URL", "https://www.vm6.ai");
    expect(getOAuthApiOrigin(request)).toBe("https://api.vm6.ai");

    mockEnv("VM0_WEB_URL", "https://external.example.test/path");
    expect(getOAuthApiOrigin(request)).toBe("https://external.example.test");
  });
});
