// Disposable operational verification for #32264. This preview PR must not merge.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { Client } from "pg";
import { z } from "zod";

import {
  decryptPersistentSecretsMap,
  decryptStoredSecretValue,
  encryptPersistentSecretsMap,
  encryptStoredSecretValue,
} from "../src/signals/services/crypto.utils.ts";

const sourceKey =
  "arn:aws:kms:us-west-2:072707626411:key/361f6727-7828-4e99-a692-9397ce396d21";
const targetKey =
  "arn:aws:kms:us-west-2:251964670836:key/1a610d49-e630-4726-9226-da01225eddfc";
const prodKey =
  "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947";
const prefix = "vm0secret:v1:";
const context = { purpose: "vm0-stored-secret" };
const original = "kms-migration-32264-synthetic-original";
const updated = "kms-migration-32264-synthetic-updated";
const originalMap = { KMS_MIGRATION_CANARY: original };
const oldPath = join(process.env.RUNNER_TEMP, "kms-32264-old.json");
const newPath = join(process.env.RUNNER_TEMP, "kms-32264-new.json");
const fixtureSchema = z.object({
  envelope: z.string(),
  map: z.string(),
  legacy: z.string(),
});
const identitySchema = z.object({ Account: z.string(), Arn: z.string() });
const phase = process.argv[2];

function keyId(ciphertext) {
  assert.ok(ciphertext.startsWith(prefix));
  return z
    .object({ kms: z.object({ keyId: z.string() }) })
    .parse(
      JSON.parse(
        Buffer.from(ciphertext.slice(prefix.length), "base64url").toString(
          "utf8",
        ),
      ),
    ).kms.keyId;
}

async function verifyIdentity(account, expectedKey) {
  assert.equal(process.env.ENV, "preview");
  assert.equal(process.env.AWS_REGION, "us-west-2");
  const acceptedWriteKeys =
    account === "072707626411"
      ? [
          sourceKey,
          sourceKey.split("/").at(-1),
          "alias/vm0-secrets-test",
          "arn:aws:kms:us-west-2:072707626411:alias/vm0-secrets-test",
        ]
      : [targetKey];
  assert.ok(acceptedWriteKeys.includes(process.env.SECRETS_KMS_KEY_ID));
  assert.ok(!process.env.AWS_SESSION_TOKEN);
  const sts = new STSClient({ maxAttempts: 1 });
  let identity;
  try {
    identity = identitySchema.parse(
      await sts.send(new GetCallerIdentityCommand({}), {
        abortSignal: AbortSignal.timeout(30_000),
      }),
    );
  } finally {
    sts.destroy();
  }
  assert.equal(identity.Account, account);
  assert.equal(identity.Arn, `arn:aws:iam::${account}:user/vm0-kms-test`);
  process.stdout.write(
    JSON.stringify({
      phase,
      runtimePrincipal: identity.Arn,
      writeKeyArn: expectedKey,
    }) + "\n",
  );
}

async function sourceFixtures() {
  await verifyIdentity("072707626411", sourceKey);
  const kms = new KMSClient({});
  const legacy = await kms.send(
    new EncryptCommand({
      KeyId: sourceKey,
      Plaintext: Buffer.from(original),
      EncryptionContext: context,
    }),
  );
  assert.ok(legacy.CiphertextBlob);
  const fixtures = {
    envelope: await encryptStoredSecretValue(original),
    map: await encryptPersistentSecretsMap(originalMap, {}),
    legacy:
      prefix +
      Buffer.from(
        JSON.stringify({
          v: 1,
          kind: "stored-secret",
          kms: {
            keyId: sourceKey,
            ciphertext: Buffer.from(legacy.CiphertextBlob).toString("base64"),
          },
        }),
      ).toString("base64url"),
  };
  const validated = fixtureSchema.parse(fixtures);
  assert.equal(keyId(validated.envelope), sourceKey);
  assert.equal(await decryptStoredSecretValue(validated.envelope), original);
  assert.equal(await decryptStoredSecretValue(validated.legacy), original);
  assert.deepEqual(
    await decryptPersistentSecretsMap(validated.map, {}),
    originalMap,
  );
  await writeFile(oldPath, JSON.stringify(validated), { mode: 0o600 });
  kms.destroy();
  process.stdout.write(
    JSON.stringify({
      phase,
      sourceApplicationWritesAndReads: "passed",
      syntheticOnly: true,
    }) + "\n",
  );
}

async function verifyNewRuntime() {
  await verifyIdentity("251964670836", targetKey);
  const old = fixtureSchema.parse(JSON.parse(await readFile(oldPath, "utf8")));
  assert.equal(await decryptStoredSecretValue(old.envelope), original);
  assert.equal(await decryptStoredSecretValue(old.legacy), original);
  assert.deepEqual(await decryptPersistentSecretsMap(old.map, {}), originalMap);
  const created = await encryptStoredSecretValue(original);
  const replacement = await encryptStoredSecretValue(updated);
  assert.equal(keyId(created), targetKey);
  assert.equal(keyId(replacement), targetKey);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      "CREATE TEMP TABLE kms_migration_32264_canary (name text PRIMARY KEY, ciphertext text NOT NULL)",
    );
    await db.query(
      "INSERT INTO kms_migration_32264_canary VALUES ($1, $2), ($3, $4)",
      ["old", old.envelope, "new", created],
    );
    const rows = z
      .array(z.object({ name: z.string(), ciphertext: z.string() }))
      .parse(
        (
          await db.query(
            "SELECT name, ciphertext FROM kms_migration_32264_canary ORDER BY name",
          )
        ).rows,
      );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(await decryptStoredSecretValue(row.ciphertext), original);
    }
    await db.query(
      "UPDATE kms_migration_32264_canary SET ciphertext = $1 WHERE name = $2",
      [replacement, "new"],
    );
    const row = z
      .object({ ciphertext: z.string() })
      .parse(
        (
          await db.query(
            "SELECT ciphertext FROM kms_migration_32264_canary WHERE name = $1",
            ["new"],
          )
        ).rows[0],
      );
    assert.equal(keyId(row.ciphertext), targetKey);
    assert.equal(await decryptStoredSecretValue(row.ciphertext), updated);
  } finally {
    // PostgreSQL drops the TEMP table with this connection; no application rows change.
    await db.end();
  }
  const newMap = await encryptPersistentSecretsMap(
    { KMS_MIGRATION_CANARY: updated },
    {},
  );
  assert.ok(newMap);
  assert.deepEqual(await decryptPersistentSecretsMap(newMap, {}), {
    KMS_MIGRATION_CANARY: updated,
  });
  await writeFile(
    newPath,
    JSON.stringify({ envelope: replacement, map: newMap }),
    { mode: 0o600 },
  );
  const kms = new KMSClient({});
  for (const deniedKey of [sourceKey, prodKey]) {
    await assert.rejects(
      kms.send(
        new GenerateDataKeyCommand({
          KeyId: deniedKey,
          KeySpec: "AES_256",
          EncryptionContext: context,
        }),
      ),
      (error) =>
        error instanceof Error && error.name === "AccessDeniedException",
    );
  }
  await assert.rejects(
    kms.send(
      new GenerateDataKeyCommand({
        KeyId: targetKey,
        KeySpec: "AES_256",
        EncryptionContext: { purpose: "kms-32264-invalid" },
      }),
    ),
    (error) => error instanceof Error && error.name === "AccessDeniedException",
  );
  kms.destroy();
  process.stdout.write(
    JSON.stringify({
      phase,
      oldEnvelopeRead: "passed",
      oldLegacyRead: "passed",
      oldMapRead: "passed",
      newCreateReadUpdateWithPostgres: "passed",
      newMapRead: "passed",
      oldKeyWriteDenied: true,
      productionKeyDenied: true,
      wrongPurposeDenied: true,
      syntheticOnly: true,
    }) + "\n",
  );
}

async function verifyRollback() {
  await verifyIdentity("072707626411", sourceKey);
  const fresh = z
    .object({ envelope: z.string(), map: z.string() })
    .parse(JSON.parse(await readFile(newPath, "utf8")));
  assert.equal(keyId(fresh.envelope), targetKey);
  assert.equal(await decryptStoredSecretValue(fresh.envelope), updated);
  assert.deepEqual(await decryptPersistentSecretsMap(fresh.map, {}), {
    KMS_MIGRATION_CANARY: updated,
  });
  process.stdout.write(
    JSON.stringify({
      phase,
      oldRuntimeReadsNewEnvelope: "passed",
      oldRuntimeReadsNewMap: "passed",
    }) + "\n",
  );
}

switch (phase) {
  case "prepare-old": {
    await sourceFixtures();
    break;
  }
  case "verify-new": {
    await verifyNewRuntime();
    break;
  }
  case "verify-rollback": {
    await verifyRollback();
    break;
  }
  default: {
    throw new Error("Expected prepare-old, verify-new, or verify-rollback");
  }
}
