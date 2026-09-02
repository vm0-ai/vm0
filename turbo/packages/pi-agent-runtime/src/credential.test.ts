import { describe, expect, it } from "vitest";

import { resolvePiAgentCredential } from "./credential";

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
});
