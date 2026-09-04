import { describe, expect, it } from "vitest";
import { piModelConfigSchema } from "@okouai/api-contracts/contracts/runners";

import {
  materializePiAgentModelConfig,
  resolvePiAgentCredential,
} from "./credential";

describe("Pi agent credential resolution", () => {
  it("keeps native provider credentials in the SDK API-key slot", () => {
    expect(
      resolvePiAgentCredential({
        credential: "native-secret",
        target: "direct",
      }),
    ).toStrictEqual({ apiKey: "native-secret" });
  });

  it("resolves a custom header directly without copying its secret into Authorization", () => {
    expect(
      resolvePiAgentCredential({
        credential: "gateway-secret",
        header: {
          name: "x-api-key",
          valueTemplate: "Key {{secret}}",
        },
        target: "direct",
      }),
    ).toStrictEqual({
      apiKey: "unused",
      requestHeaders: {
        authorization: null,
        "x-api-key": "Key gateway-secret",
      },
    });
  });

  it("sends only the placeholder through the Sandbox firewall", () => {
    expect(
      resolvePiAgentCredential({
        credential: "safe-placeholder",
        header: {
          name: "Authorization",
          valueTemplate: "Bearer {{secret}}",
        },
        target: "sandbox-firewall",
      }),
    ).toStrictEqual({
      apiKey: "unused",
      requestHeaders: { Authorization: "safe-placeholder" },
    });
  });

  it("overrides the SDK Authorization value with the configured template", () => {
    expect(
      resolvePiAgentCredential({
        credential: "gateway-secret",
        header: {
          name: "Authorization",
          valueTemplate: "Bearer {{secret}}",
        },
        target: "direct",
      }),
    ).toStrictEqual({
      apiKey: "unused",
      requestHeaders: { Authorization: "Bearer gateway-secret" },
    });
  });

  it.each(["missing placeholder", "{{secret}} {{other}}"])(
    "fails closed for malformed credential header policy %s",
    (valueTemplate) => {
      expect(() => {
        resolvePiAgentCredential({
          credential: "gateway-secret",
          header: { name: "x-api-key", valueTemplate },
          target: "direct",
        });
      }).toThrow("Pi credential header policy is invalid");
    },
  );

  it("materializes legacy routes as public Responses", async () => {
    const config = piModelConfigSchema.parse({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-terra",
      api: "openai-codex-responses",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "OPENAI_API_KEY",
    });

    await expect(
      materializePiAgentModelConfig({
        config,
        target: "direct",
        resolveCredential(binding) {
          expect(binding).toMatchObject({
            kind: "api-key",
            environment: "OPENAI_API_KEY",
            secretName: "OPENAI_API_KEY",
          });
          return "legacy-key";
        },
      }),
    ).resolves.toMatchObject({
      api: "openai-responses",
      dialect: "openai-responses",
      apiKey: "legacy-key",
    });
  });

  it("materializes both exact subscription values from the same binding set", async () => {
    const config = piModelConfigSchema.parse({
      schemaVersion: 2,
      dialect: "openai-codex-responses",
      transport: "sse",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.6-terra",
      thinkingLevel: "low",
      credentialBindings: [
        {
          kind: "account-id",
          environment: "CHATGPT_ACCOUNT_ID",
          secretName: "CHATGPT_ACCOUNT_ID",
        },
        {
          kind: "access-token",
          environment: "CHATGPT_ACCESS_TOKEN",
          secretName: "CHATGPT_ACCESS_TOKEN",
        },
      ],
    });
    const resolutionOrder: string[] = [];
    await expect(
      materializePiAgentModelConfig({
        config,
        target: "direct",
        resolveCredential(binding) {
          resolutionOrder.push(binding.kind);
          switch (binding.environment) {
            case "CHATGPT_ACCESS_TOKEN":
              return "opaque-access-token";
            case "CHATGPT_ACCOUNT_ID":
              return "account-id";
            default:
              throw new Error("Unexpected subscription binding");
          }
        },
      }),
    ).resolves.toStrictEqual({
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      model: "gpt-5.6-terra",
      thinkingLevel: "low",
      api: "openai-codex-responses",
      dialect: "openai-codex-responses",
      transport: "sse",
      apiKey: "opaque-access-token",
      accountId: "account-id",
    });
    expect(resolutionOrder).toStrictEqual(["access-token", "account-id"]);
  });
});
