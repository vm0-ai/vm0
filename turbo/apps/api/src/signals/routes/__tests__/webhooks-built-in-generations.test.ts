import { describe, expect, it } from "vitest";

import { providerFailureDetailsForLog } from "../webhooks-built-in-generations";

describe("providerFailureDetailsForLog", () => {
  it("extracts common top-level provider failure fields", () => {
    expect(
      providerFailureDetailsForLog({
        status: "failed",
        reason: "content policy rejected the prompt",
        error_code: "CONTENT_POLICY",
        logs: ["validation failed", "retry not allowed"],
      }),
    ).toStrictEqual({
      reason: "content policy rejected the prompt",
      errorCode: "CONTENT_POLICY",
      logs: "validation failed\nretry not allowed",
    });
  });

  it("extracts nested Fal response failure fields", () => {
    expect(
      providerFailureDetailsForLog({
        status: "ERROR",
        response: {
          error: {
            message: "upstream worker timed out",
            code: "TIMEOUT",
          },
        },
      }),
    ).toStrictEqual({
      error: "upstream worker timed out",
    });
  });

  it("extracts nested BytePlus payload failure fields", () => {
    expect(
      providerFailureDetailsForLog({
        status: "failed",
        data: {
          error_message: "model capacity exceeded",
          status_message: "no worker available",
        },
      }),
    ).toStrictEqual({
      errorMessage: "model capacity exceeded",
      statusMessage: "no worker available",
    });
  });

  it("reports the Fal validation reason without the echoed request input", () => {
    const details = providerFailureDetailsForLog({
      status: "ERROR",
      error: "Unexpected status code: 422",
      detail: {
        input: {
          prompt: "a portrait of Sarah outside the office on Howard St",
          image_urls: ["https://example-ref.sites.vm0.io/reference.png"],
          image_size: { height: 1024, width: 1024 },
        },
        loc: ["body", "image_urls", 0],
        msg: "Failed to download the file. Please check if the URL is accessible and try again.",
        type: "value_error",
      },
    });
    expect(details).toStrictEqual({
      error: "Unexpected status code: 422",
      detail:
        "Failed to download the file. Please check if the URL is accessible and try again.",
    });
  });

  it("never serializes an unrecognized object, whichever key carries it", () => {
    const echoed = {
      input: { prompt: "a portrait of Sarah outside the office on Howard St" },
    };
    for (const key of ["detail", "message", "error", "reason", "description"]) {
      const details = providerFailureDetailsForLog({
        status: "ERROR",
        [key]: echoed,
      });
      // Assert over the whole result: a fix that only moves the leak to a
      // different log field must not pass.
      expect(JSON.stringify(details)).not.toContain("Sarah");
    }
  });

  it("redacts presigned URLs left inside a provider message", () => {
    expect(
      providerFailureDetailsForLog({
        status: "ERROR",
        message:
          "could not read https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=deadbeef",
      }),
    ).toStrictEqual({
      message: "could not read [redacted presigned URL]",
    });
  });
});
