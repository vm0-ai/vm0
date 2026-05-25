import { describe, expect, it } from "vitest";

import { providerFailureDetailsForLog } from "../webhooks-built-in-generations";
import { bytePlusBuiltInGenerationError } from "../../services/zero-video-io-generate.service";

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

describe("bytePlusBuiltInGenerationError", () => {
  it("maps BytePlus invalid parameter errors to a specific built-in generation error", () => {
    expect(
      bytePlusBuiltInGenerationError({
        error: {
          code: "InvalidParameter",
          message:
            "The parameter `content[1].image_url` specified in the request is not valid.",
          param: "content[1].image_url",
          type: "BadRequest",
        },
      }),
    ).toStrictEqual({
      message:
        "BytePlus video generation failed: The parameter `content[1].image_url` specified in the request is not valid. (content[1].image_url)",
      code: "BYTEPLUS_INVALID_PARAMETER",
    });
  });

  it("maps BytePlus content safety errors to a specific built-in generation error", () => {
    expect(
      bytePlusBuiltInGenerationError({
        status: "failed",
        error: {
          code: "InputImageSensitiveContentDetected.PrivacyInformation",
          message:
            "The request failed because the input image may contain real person.",
          type: "BadRequest",
        },
      }),
    ).toStrictEqual({
      message:
        "BytePlus video generation failed: The request failed because the input image may contain real person.",
      code: "BYTEPLUS_INPUT_IMAGE_SENSITIVE_CONTENT_DETECTED_PRIVACY_INFORMATION",
    });
  });
});
