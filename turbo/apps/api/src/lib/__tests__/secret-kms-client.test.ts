import { describe, expect, it } from "vitest";

import {
  getSecretKmsClient,
  setSecretKmsClientForTests,
  type SecretKmsClient,
  withSecretKmsClientForTest,
} from "../secret-kms-client";

function testClient(): SecretKmsClient {
  return {
    generateDataKey: () => {
      return Promise.reject(new Error("unused generateDataKey"));
    },
    decrypt: () => {
      return Promise.reject(new Error("unused decrypt"));
    },
  };
}

describe("secret KMS client", () => {
  it("isolates overrides across concurrent test scopes", async () => {
    const outerClient = getSecretKmsClient();
    const firstClient = testClient();
    const updatedFirstClient = testClient();
    const secondClient = testClient();

    const [firstResult, secondResult] = await Promise.all([
      withSecretKmsClientForTest(firstClient, async () => {
        expect(getSecretKmsClient()).toBe(firstClient);
        await Promise.resolve();
        setSecretKmsClientForTests(updatedFirstClient);
        await Promise.resolve();
        return getSecretKmsClient();
      }),
      withSecretKmsClientForTest(secondClient, async () => {
        expect(getSecretKmsClient()).toBe(secondClient);
        await Promise.resolve();
        expect(getSecretKmsClient()).toBe(secondClient);
        return getSecretKmsClient();
      }),
    ]);

    expect(firstResult).toBe(updatedFirstClient);
    expect(secondResult).toBe(secondClient);
    expect(getSecretKmsClient()).toBe(outerClient);
  });
});
