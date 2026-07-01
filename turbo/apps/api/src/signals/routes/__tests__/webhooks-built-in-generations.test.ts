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
});
