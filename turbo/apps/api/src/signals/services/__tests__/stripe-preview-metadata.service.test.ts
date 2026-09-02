import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  isCurrentStripePreviewMetadata,
  stripePreviewMetadata,
} from "../stripe-preview-metadata.service";

const PREVIEW_JOB_REF_ENV_KEY = "OKOU_PREVIEW_JOB_REF";

function configurePreview(
  environment: "preview" | "production",
  jobRef: string | undefined,
): void {
  mockEnv("ENV", environment);
  mockOptionalEnv(PREVIEW_JOB_REF_ENV_KEY, jobRef);
}

describe("Stripe preview metadata", () => {
  it.each([
    ["absent", undefined],
    ["empty", ""],
  ] as const)(
    "keeps no-job behavior when the job reference is %s",
    (_, jobRef) => {
      configurePreview("preview", jobRef);

      expect(stripePreviewMetadata()).toStrictEqual({});
      expect(isCurrentStripePreviewMetadata(null)).toBeTruthy();
      expect(
        isCurrentStripePreviewMetadata({
          vm0_environment: "preview",
          job_ref: "another-preview-job",
        }),
      ).toBeTruthy();
    },
  );

  it("adds exact metadata and matches the current preview job", () => {
    configurePreview("preview", "current-preview-job");
    const currentMetadata = {
      vm0_environment: "preview",
      job_ref: "current-preview-job",
    };

    expect(stripePreviewMetadata()).toStrictEqual(currentMetadata);
    expect(isCurrentStripePreviewMetadata(currentMetadata)).toBeTruthy();
    expect(
      isCurrentStripePreviewMetadata({
        ...currentMetadata,
        purpose: "checkout",
      }),
    ).toBeTruthy();
    expect(
      isCurrentStripePreviewMetadata({
        vm0_environment: "preview",
        job_ref: "another-preview-job",
      }),
    ).toBeFalsy();
    expect(
      isCurrentStripePreviewMetadata({
        vm0_environment: "production",
        job_ref: "current-preview-job",
      }),
    ).toBeFalsy();
    expect(isCurrentStripePreviewMetadata(null)).toBeFalsy();
  });

  it("keeps non-preview behavior unchanged", () => {
    configurePreview("production", "production-job-ref");

    expect(stripePreviewMetadata()).toStrictEqual({});
    expect(isCurrentStripePreviewMetadata(null)).toBeTruthy();
  });
});
