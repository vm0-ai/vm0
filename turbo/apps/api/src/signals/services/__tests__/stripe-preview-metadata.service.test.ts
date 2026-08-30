import { createHash } from "node:crypto";

import { EVENT } from "@axiomhq/logging";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  isCurrentStripePreviewMetadata,
  stripePreviewMetadata,
} from "../stripe-preview-metadata.service";

const context = testContext();

const CANONICAL_PREVIEW_JOB_REF_ENV_KEY = "OKOU_PREVIEW_JOB_REF";
const LEGACY_PREVIEW_JOB_REF_ENV_KEY = "VM0_PREVIEW_JOB_REF";
const PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT =
  "stripe_preview_job_ref_alias_resolution";
const PREVIEW_JOB_REF_LOG_CONTEXT = "StripePreviewMetadata";

type PreviewJobRefAliasState =
  | "absent"
  | "canonical-only"
  | "legacy-only"
  | "equal-dual"
  | "conflicting-dual";

interface PreviewJobRefAliasFixture {
  readonly name: string;
  readonly canonical: string | undefined;
  readonly legacy: string | undefined;
  readonly state: PreviewJobRefAliasState;
  readonly jobRef: string | null;
}

const PREVIEW_JOB_REF_ALIAS_FIXTURES: readonly PreviewJobRefAliasFixture[] = [
  {
    name: "absent aliases",
    canonical: undefined,
    legacy: undefined,
    state: "absent",
    jobRef: null,
  },
  {
    name: "empty canonical alias",
    canonical: "",
    legacy: undefined,
    state: "absent",
    jobRef: null,
  },
  {
    name: "empty legacy alias",
    canonical: undefined,
    legacy: "",
    state: "absent",
    jobRef: null,
  },
  {
    name: "empty dual aliases",
    canonical: "",
    legacy: "",
    state: "absent",
    jobRef: null,
  },
  {
    name: "canonical-only alias",
    canonical: "canonical-preview-job",
    legacy: undefined,
    state: "canonical-only",
    jobRef: "canonical-preview-job",
  },
  {
    name: "canonical-only alias with an empty legacy value",
    canonical: "canonical-preview-job",
    legacy: "",
    state: "canonical-only",
    jobRef: "canonical-preview-job",
  },
  {
    name: "legacy-only alias",
    canonical: undefined,
    legacy: "legacy-preview-job",
    state: "legacy-only",
    jobRef: "legacy-preview-job",
  },
  {
    name: "legacy-only alias with an empty canonical value",
    canonical: "",
    legacy: "legacy-preview-job",
    state: "legacy-only",
    jobRef: "legacy-preview-job",
  },
  {
    name: "equal dual aliases",
    canonical: "shared-preview-job",
    legacy: "shared-preview-job",
    state: "equal-dual",
    jobRef: "shared-preview-job",
  },
];

function configureAliases(
  environment: "preview" | "production",
  canonical: string | undefined,
  legacy: string | undefined,
): void {
  mockEnv("ENV", environment);
  mockOptionalEnv(CANONICAL_PREVIEW_JOB_REF_ENV_KEY, canonical);
  mockOptionalEnv(LEGACY_PREVIEW_JOB_REF_ENV_KEY, legacy);
}

function aliasEvidence(
  state: PreviewJobRefAliasState,
): Record<string, unknown> {
  return {
    [EVENT]: { source: "api" },
    canonicalKey: CANONICAL_PREVIEW_JOB_REF_ENV_KEY,
    legacyKey: LEGACY_PREVIEW_JOB_REF_ENV_KEY,
    state,
    context: PREVIEW_JOB_REF_LOG_CONTEXT,
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

describe("Stripe preview metadata job reference aliases", () => {
  it("resolves the matrix with one value-free info event per state", () => {
    const reportedStates = new Set<PreviewJobRefAliasState>();

    for (const {
      canonical,
      legacy,
      state,
      jobRef,
    } of PREVIEW_JOB_REF_ALIAS_FIXTURES) {
      configureAliases("preview", canonical, legacy);
      const logCount = context.mocks.axiomLogging.info.mock.calls.filter(
        ([message]) => {
          return message === PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT;
        },
      ).length;
      const expectedMetadata: Readonly<Record<string, string>> = jobRef
        ? { vm0_environment: "preview", job_ref: jobRef }
        : {};

      expect(stripePreviewMetadata()).toStrictEqual(expectedMetadata);
      expect(isCurrentStripePreviewMetadata(expectedMetadata)).toBeTruthy();
      expect(isCurrentStripePreviewMetadata(null)).toBe(jobRef === null);

      const aliasResolutionCalls = context.mocks.axiomLogging.info.mock.calls
        .filter(([message]) => {
          return message === PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT;
        })
        .slice(logCount);
      const expectedCalls = reportedStates.has(state)
        ? []
        : [[PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT, aliasEvidence(state)]];
      expect(aliasResolutionCalls).toStrictEqual(expectedCalls);
      reportedStates.add(state);
      const configuredValues = [canonical, legacy].filter(
        (value): value is string => {
          return Boolean(value);
        },
      );
      expectValueFree(JSON.stringify(aliasResolutionCalls), configuredValues);
    }

    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalledWith(
      PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT,
      expect.anything(),
    );
    expect(context.mocks.axiomLogging.warn).not.toHaveBeenCalled();
  });

  it("fails closed on unequal dual aliases without exposing either value", () => {
    const canonical = "canonical-job-ref-must-not-leak";
    const legacy = "legacy-job-ref-must-not-leak";
    configureAliases("preview", canonical, legacy);
    const expectedMessage =
      "Preview job reference aliases conflict: canonicalKey=OKOU_PREVIEW_JOB_REF legacyKey=VM0_PREVIEW_JOB_REF state=conflicting-dual";

    expect(() => {
      stripePreviewMetadata();
    }).toThrow(expectedMessage);
    expect(() => {
      isCurrentStripePreviewMetadata({
        vm0_environment: "preview",
        job_ref: "metadata-job-ref",
      });
    }).toThrow(expectedMessage);

    expect(context.mocks.axiomLogging.warn.mock.calls).toStrictEqual([
      [
        PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT,
        aliasEvidence("conflicting-dual"),
      ],
    ]);
    const diagnostics = JSON.stringify({
      error: expectedMessage,
      logs: context.mocks.axiomLogging.warn.mock.calls,
    });
    expectValueFree(diagnostics, [canonical, legacy]);
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalledWith(
      PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT,
      expect.anything(),
    );
    expect(context.mocks.axiomLogging.info).not.toHaveBeenCalledWith(
      PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT,
      expect.anything(),
    );
  });

  it("ignores preview alias conflicts outside preview deployments", () => {
    configureAliases(
      "production",
      "canonical-production-job-ref",
      "legacy-production-job-ref",
    );

    expect(stripePreviewMetadata()).toStrictEqual({});
    expect(isCurrentStripePreviewMetadata(null)).toBeTruthy();
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalledWith(
      PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT,
      expect.anything(),
    );
    expect(context.mocks.axiomLogging.info).not.toHaveBeenCalledWith(
      PREVIEW_JOB_REF_ALIAS_RESOLUTION_EVENT,
      expect.anything(),
    );
    expect(context.mocks.axiomLogging.warn).not.toHaveBeenCalled();
  });
});
