#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";

import {
  decode,
  decrypt,
  encode,
  encrypt,
  encryptionContext,
  object,
  rewrap,
  string,
} from "./kms";

const source =
  "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8";
const target =
  "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947";
const testKey =
  "arn:aws:kms:us-west-2:251964670836:key/1a610d49-e630-4726-9226-da01225eddfc";
const plaintext = Buffer.from("kms-32264-production-synthetic-only");

async function main(): Promise<void> {
  const phase = string(process.argv[2]);
  const directory = string(process.argv[3]);
  assert.ok(
    [
      "prepare-old",
      "verify-new",
      "verify-rollback",
      "verify-operator",
    ].includes(phase),
  );
  const account =
    phase === "verify-new" || phase === "verify-operator"
      ? "251964670836"
      : "072707626411";
  const identity = object(
    JSON.parse(await readFile(join(directory, "identity.json"), "utf8")),
  );
  assert.equal(identity.Account, account);
  if (phase === "verify-operator") {
    assert.match(
      string(identity.Arn),
      /^arn:aws:sts::251964670836:assumed-role\/vm0-kms-migration-github-32264\/github-kms-[0-9]+$/u,
    );
  } else {
    assert.equal(identity.Arn, `arn:aws:iam::${account}:user/vm0-kms-prod`);
  }
  const configuredKey = process.env.SECRETS_KMS_KEY_ID;
  assert.ok(
    phase === "verify-new" || phase === "verify-operator"
      ? configuredKey === target
      : [
          source,
          source.split("/").at(-1),
          "alias/vm0-secrets-prod",
          "arn:aws:kms:us-west-2:072707626411:alias/vm0-secrets-prod",
        ].includes(configuredKey),
  );
  const kms = new KMSClient({
    region: "us-west-2",
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
  });
  async function verify(ciphertext: string): Promise<void> {
    const envelope = decode(ciphertext);
    const clear = await decrypt(kms, envelope, envelope.kms.keyId);
    try {
      assert.ok(clear.equals(plaintext));
    } finally {
      clear.fill(0);
    }
  }
  try {
    if (phase === "prepare-old") {
      const direct = await kms.send(
        new EncryptCommand({
          KeyId: source,
          Plaintext: plaintext,
          EncryptionContext: encryptionContext,
        }),
      );
      assert.equal(direct.KeyId, source);
      assert.ok(direct.CiphertextBlob);
      const fixture = {
        envelope: encode(await encrypt(kms, plaintext, source)),
        legacy: encode({
          v: 1,
          kind: "stored-secret",
          kms: {
            keyId: source,
            ciphertext: Buffer.from(direct.CiphertextBlob).toString("base64"),
          },
        }),
      };
      await verify(fixture.envelope);
      await verify(fixture.legacy);
      await writeFile(join(directory, "old.json"), JSON.stringify(fixture), {
        mode: 0o600,
      });
    } else if (phase === "verify-new") {
      const old = object(
        JSON.parse(await readFile(join(directory, "old.json"), "utf8")),
      );
      await verify(string(old.envelope));
      await verify(string(old.legacy));
      const fresh = encode(await encrypt(kms, plaintext, target));
      await verify(fresh);
      await writeFile(
        join(directory, "new.json"),
        JSON.stringify({ envelope: fresh }),
        { mode: 0o600 },
      );
      for (const key of [source, testKey, target]) {
        await assert.rejects(
          kms.send(
            new GenerateDataKeyCommand({
              KeyId: key,
              KeySpec: "AES_256",
              EncryptionContext:
                key === target
                  ? { purpose: "kms-32264-invalid" }
                  : encryptionContext,
            }),
          ),
          (error: unknown) => {
            return (
              error instanceof Error && error.name === "AccessDeniedException"
            );
          },
        );
      }
    } else if (phase === "verify-rollback") {
      const fresh = object(
        JSON.parse(await readFile(join(directory, "new.json"), "utf8")),
      );
      assert.equal(decode(string(fresh.envelope)).kms.keyId, target);
      await verify(string(fresh.envelope));
    } else {
      const old = object(
        JSON.parse(await readFile(join(directory, "old.json"), "utf8")),
      );
      for (const value of [old.envelope, old.legacy]) {
        const original = decode(string(value));
        const moved = await rewrap(kms, original, source, target);
        assert.equal(moved.kms.keyId, target);
        await verify(encode(moved));
        const restored = await rewrap(kms, moved, target, source);
        assert.equal(restored.kms.keyId, source);
        await verify(encode(restored));
        if (original.kms.encryptedDataKey) {
          for (const envelope of [moved, restored]) {
            assert.equal(envelope.kms.ciphertext, original.kms.ciphertext);
            assert.equal(envelope.kms.iv, original.kms.iv);
            assert.equal(envelope.kms.authTag, original.kms.authTag);
          }
        }
      }
    }
    process.stdout.write(
      JSON.stringify({
        phase,
        principal: identity.Arn,
        result: "passed",
        syntheticOnly: true,
      }) + "\n",
    );
  } finally {
    kms.destroy();
    plaintext.fill(0);
  }
}

main().catch(() => {
  process.stderr.write(
    "Production KMS synthetic credential verification failed.\n",
  );
  process.exitCode = 1;
});
