import { createHash } from "node:crypto";

import { EVENT } from "@axiomhq/logging";
import { describe, expect, it } from "vitest";

import { testContext } from "../../__tests__/test-context";
import {
  apiBackendUrl,
  reportApiBackendUrlAliasSourceAtProcessInitialization,
} from "../api-backend-url";
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
  readonly initializationCanonical: string | undefined;
  readonly initializationLegacy: string | undefined;
  readonly consumerCanonical: string | undefined;
  readonly consumerLegacy: string | undefined;
  readonly expected: string | undefined;
}

const API_BACKEND_URL_ALIAS_FIXTURES: readonly ApiBackendUrlAliasFixture[] = [
  {
    state: "absent",
    initializationCanonical: undefined,
    initializationLegacy: undefined,
    consumerCanonical: undefined,
    consumerLegacy: undefined,
    expected: undefined,
  },
  {
    state: "canonical-only",
    initializationCanonical: "https://initial-canonical-only.example.test/path",
    initializationLegacy: undefined,
    consumerCanonical: "https://consumer-canonical-only.example.test/path",
    consumerLegacy: undefined,
    expected: "https://consumer-canonical-only.example.test/path",
  },
  {
    state: "legacy-only",
    initializationCanonical: undefined,
    initializationLegacy: "https://initial-legacy-only.example.test/path",
    consumerCanonical: undefined,
    consumerLegacy: "https://consumer-legacy-only.example.test/path",
    expected: "https://consumer-legacy-only.example.test/path",
  },
  {
    state: "equal-dual",
    initializationCanonical: "https://initial-equal-dual.example.test/path",
    initializationLegacy: "https://initial-equal-dual.example.test/path",
    consumerCanonical: "https://consumer-equal-dual.example.test/path",
    consumerLegacy: "https://consumer-equal-dual.example.test/path",
    expected: "https://consumer-equal-dual.example.test/path",
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
  it("observes then resolves every non-conflicting state without retaining values", () => {
    for (const fixture of API_BACKEND_URL_ALIAS_FIXTURES) {
      configureAliases(
        fixture.initializationCanonical,
        fixture.initializationLegacy,
      );
      const logCount = context.mocks.axiomLogging.info.mock.calls.length;

      expect(
        reportApiBackendUrlAliasSourceAtProcessInitialization(),
      ).toBeUndefined();
      expect(
        reportApiBackendUrlAliasSourceAtProcessInitialization(),
      ).toBeUndefined();

      configureAliases(fixture.consumerCanonical, fixture.consumerLegacy);
      expect(apiBackendUrl()).toBe(fixture.expected);
      expect(apiBackendUrl()).toBe(fixture.expected);

      const calls = context.mocks.axiomLogging.info.mock.calls.slice(logCount);
      expect(calls).toStrictEqual([
        [API_BACKEND_URL_ALIAS_RESOLUTION_EVENT, aliasEvidence(fixture.state)],
      ]);
      expectValueFree(
        JSON.stringify(calls),
        [
          fixture.initializationCanonical,
          fixture.initializationLegacy,
          fixture.consumerCanonical,
          fixture.consumerLegacy,
        ].filter((value): value is string => {
          return value !== undefined;
        }),
      );
    }
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.warn).not.toHaveBeenCalled();
  });

  it("fails closed on conflicting aliases with bounded value-free diagnostics", () => {
    const initializationCanonical =
      "https://initial-canonical-conflict-must-not-leak.example.test/path";
    const initializationLegacy =
      "https://initial-legacy-conflict-must-not-leak.example.test/path";
    const consumerCanonical =
      "https://consumer-canonical-conflict-must-not-leak.example.test/path";
    const consumerLegacy =
      "https://consumer-legacy-conflict-must-not-leak.example.test/path";
    const expectedMessage =
      "API backend URL aliases conflict: canonicalKey=OKOU_API_BACKEND_URL legacyKey=VM0_API_BACKEND_URL state=conflicting-dual";
    configureAliases(initializationCanonical, initializationLegacy);

    expect(
      reportApiBackendUrlAliasSourceAtProcessInitialization(),
    ).toBeUndefined();
    expect(
      reportApiBackendUrlAliasSourceAtProcessInitialization(),
    ).toBeUndefined();

    configureAliases(consumerCanonical, consumerLegacy);

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
    expectValueFree(diagnostics, [
      initializationCanonical,
      initializationLegacy,
      consumerCanonical,
      consumerLegacy,
    ]);
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
