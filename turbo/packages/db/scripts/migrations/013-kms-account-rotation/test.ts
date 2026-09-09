#!/usr/bin/env tsx

// CLI integration: a real, isolated Postgres database and an HTTP KMS boundary.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { Client } from "pg";

import { fields } from "./fields";
import {
  decode,
  decrypt,
  encode,
  encrypt,
  encryptionContext,
  object,
  prefix,
  string,
} from "./kms";

const source =
  "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8";
const target =
  "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947";
const secret = "synthetic-secret-that-must-never-appear-in-cli-output";
const input = new URL(string(process.env.DATABASE_URL));
assert.ok(
  ["localhost", "127.0.0.1", "postgres"].includes(input.hostname),
  "Integration tests require local PostgreSQL",
);
const databaseName = `kms_rotation_test_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: input.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
input.pathname = `/${databaseName}`;
const db = new Client({ connectionString: input.toString() });
await db.connect();
const directory = await mkdtemp(join(tmpdir(), "kms-rotation-test-"));
const blobs = new Map<string, { key: string; plaintext: Buffer }>();
let kmsRequests = 0;
let beforeRewrap: (() => Promise<void>) | undefined;
let failRewrap = false;
function wrap(plaintext: Buffer, key: string): string {
  const blob = randomBytes(64).toString("base64");
  blobs.set(blob, { key, plaintext: Buffer.from(plaintext) });
  return blob;
}
const server = createServer((request, response) => {
  async function handle(): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    kmsRequests++;
    const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const operation = string(request.headers["x-amz-target"]).split(".").at(-1);
    const context = object(
      operation === "ReEncrypt"
        ? body.SourceEncryptionContext
        : body.EncryptionContext,
    );
    assert.deepEqual(context, encryptionContext);
    let result: Record<string, unknown>;
    if (operation === "GenerateDataKey" || operation === "Encrypt") {
      const plain =
        operation === "Encrypt"
          ? Buffer.from(string(body.Plaintext), "base64")
          : randomBytes(32);
      result = {
        KeyId: body.KeyId,
        CiphertextBlob: wrap(plain, string(body.KeyId)),
      };
      if (operation === "GenerateDataKey") {
        result.Plaintext = plain.toString("base64");
      }
    } else {
      const stored = blobs.get(string(body.CiphertextBlob));
      assert.ok(stored);
      assert.equal(
        stored.key,
        operation === "ReEncrypt" ? body.SourceKeyId : body.KeyId,
      );
      if (operation === "Decrypt") {
        result = {
          KeyId: stored.key,
          Plaintext: stored.plaintext.toString("base64"),
        };
      } else {
        assert.equal(operation, "ReEncrypt");
        assert.deepEqual(body.DestinationEncryptionContext, encryptionContext);
        if (failRewrap) {
          response.writeHead(400, {
            "content-type": "application/x-amz-json-1.1",
          });
          response.end(
            JSON.stringify({
              __type: "AccessDeniedException",
              message: secret,
            }),
          );
          return;
        }
        const concurrentWrite = beforeRewrap;
        beforeRewrap = undefined;
        await concurrentWrite?.();
        result = {
          SourceKeyId: stored.key,
          KeyId: body.DestinationKeyId,
          CiphertextBlob: wrap(stored.plaintext, string(body.DestinationKeyId)),
        };
      }
    }
    response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
    response.end(JSON.stringify(result));
  }
  handle().catch(() => {
    response.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
    response.end(
      JSON.stringify({
        __type: "InvalidCiphertextException",
        message: "synthetic KMS rejected request",
      }),
    );
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}`;
const kms = new KMSClient({
  region: "us-west-2",
  endpoint,
  credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
});
const execute = promisify(execFile);
const script = "scripts/migrations/013-kms-account-rotation/backfill.ts";
async function cli(
  name: string,
  args: string[] = [],
  reverse = false,
  expectedFailure = false,
): Promise<Record<string, unknown>> {
  const reportPath = join(directory, `${name}.json`);
  const command = [
    "exec",
    "tsx",
    script,
    "--source-key",
    reverse ? target : source,
    "--target-key",
    reverse ? source : target,
    "--report-path",
    reportPath,
    ...args,
  ];
  let failed = false;
  let stdout = "";
  let stderr = "";
  try {
    const output = await execute("pnpm", command, {
      env: {
        ...process.env,
        DATABASE_URL: input.toString(),
        AWS_ACCESS_KEY_ID: "synthetic",
        AWS_SECRET_ACCESS_KEY: "synthetic",
        AWS_SESSION_TOKEN: "",
        AWS_ENDPOINT_URL_KMS: endpoint,
      },
    });
    stdout = output.stdout;
    stderr = output.stderr;
  } catch (error) {
    failed = true;
    const failure = object(error);
    stdout = string(failure.stdout);
    stderr = string(failure.stderr);
  }
  assert.equal(failed, expectedFailure, stderr);
  assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
  const raw = await readFile(reportPath, "utf8");
  assert.ok(!raw.includes(secret));
  return object(JSON.parse(raw));
}
async function stored(
  table: string,
  column: string,
  id: string,
): Promise<string> {
  const key = fields.find((field) => {
    return field.table === table;
  })?.primaryKey;
  assert.ok(key);
  const rows: unknown[] = (
    await db.query(
      `SELECT "${column}" AS value FROM "${table}" WHERE "${key}" = $1`,
      [id],
    )
  ).rows;
  return string(object(rows[0]).value);
}
try {
  const tables = new Map<string, string[]>();
  for (const field of fields) {
    if (field.optional) {
      continue;
    }
    const columns = tables.get(field.table) ?? [
      `"${field.primaryKey}" text PRIMARY KEY`,
    ];
    columns.push(`"${field.column}" ${field.jsonKey ? "jsonb" : "text"}`);
    tables.set(field.table, columns);
  }
  for (const [table, columns] of tables) {
    await db.query(`CREATE TABLE "${table}" (${columns.join(", ")})`);
  }
  const original = encode(await encrypt(kms, Buffer.from(secret), source));
  const latest = encode(
    await encrypt(kms, Buffer.from(`${secret}-updated`), source),
  );
  const direct = await kms.send(
    new EncryptCommand({
      KeyId: source,
      Plaintext: Buffer.from(secret),
      EncryptionContext: encryptionContext,
    }),
  );
  assert.ok(direct.CiphertextBlob);
  const legacy = encode({
    v: 1,
    kind: "stored-secret",
    kms: {
      keyId: source,
      ciphertext: Buffer.from(direct.CiphertextBlob).toString("base64"),
    },
  });
  const bareKey = decode(original);
  const bare = encode({
    ...bareKey,
    kms: { ...bareKey.kms, keyId: string(source.split("/").at(-1)) },
  });
  await db.query(
    "INSERT INTO secrets VALUES ('01', $1), ('02', $2), ('03', $3)",
    [original, legacy, bare],
  );
  await db.query("INSERT INTO runner_job_queue VALUES ('run', $1)", [
    JSON.stringify({ encryptedSecrets: original, keep: "unchanged" }),
  ]);
  const payload = {
    version: 1,
    executionContext: { encryptedSecrets: original, extra: 42 },
    runnerGroup: "synthetic",
  };
  const outer = encode(
    await encrypt(
      kms,
      Buffer.from(
        JSON.stringify({ __api_runner_job_payload__: JSON.stringify(payload) }),
      ),
      target,
    ),
  );
  await db.query("INSERT INTO agent_run_queue VALUES ('queued', $1)", [outer]);

  const beforeInventory = kmsRequests;
  const inventory = await cli("inventory");
  assert.equal(inventory.complete, true);
  assert.equal(kmsRequests, beforeInventory, "Inventory must not call KMS");
  assert.equal(object(inventory.totals).nestedUninspected, 1);
  assert.equal(object(inventory.totals).nonArn, 1);
  const limited = await cli("limited", ["--max-rows", "1"]);
  assert.equal(limited.complete, false);
  const resumed = await cli("inventory-resume", [
    "--cursor",
    string(limited.cursor),
  ]);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.resumed, true);

  const verified = await cli("preflight", ["--verify"]);
  assert.equal(verified.complete, true);
  assert.equal(object(verified.totals).nestedSource, 1);
  assert.equal(verified.databaseVerifiedOnTarget, false);
  assert.equal(await stored("secrets", "encrypted_value", "01"), original);
  beforeRewrap = async () => {
    await db.query("UPDATE secrets SET encrypted_value = $1 WHERE id = '01'", [
      latest,
    ]);
    await db.query(
      "UPDATE runner_job_queue SET execution_context = jsonb_set(execution_context, '{keep}', '\"concurrent\"') WHERE run_id = 'run'",
    );
  };
  const bounded = await cli("bounded-migrate", [
    "--migrate",
    "--preflight",
    join(directory, "preflight.json"),
    "--max-rows",
    "2",
  ]);
  assert.equal(bounded.complete, false);
  assert.equal(object(bounded.totals).concurrentChanges, 1);
  assert.equal(
    await stored("secrets", "encrypted_value", "01"),
    latest,
    "CAS must preserve a concurrent credential update",
  );
  await cli("resume-migrate", [
    "--migrate",
    "--preflight",
    join(directory, "preflight.json"),
    "--cursor",
    string(bounded.cursor),
  ]);
  const afterResume = await cli("post-resume", ["--verify"]);
  assert.equal(
    object(afterResume.totals).source,
    1,
    "A fresh scan must rediscover a skipped concurrent write",
  );
  const moved = decode(await stored("secrets", "encrypted_value", "03"));
  assert.equal(moved.kms.iv, bareKey.kms.iv);
  assert.equal(moved.kms.authTag, bareKey.kms.authTag);
  assert.equal(moved.kms.ciphertext, bareKey.kms.ciphertext);
  assert.equal(moved.kms.keyId, target);
  assert.notEqual(moved.kms.encryptedDataKey, bareKey.kms.encryptedDataKey);
  const queueRows: unknown[] = (
    await db.query("SELECT execution_context FROM runner_job_queue")
  ).rows;
  assert.equal(
    object(object(queueRows[0]).execution_context).keep,
    "concurrent",
  );
  const newOuter = decode(
    await stored("agent_run_queue", "encrypted_params", "queued"),
  );
  assert.notEqual(newOuter.kms.iv, decode(outer).kms.iv);
  const queuePlaintext = await decrypt(kms, newOuter, target);
  const newMap = object(JSON.parse(queuePlaintext.toString("utf8")));
  queuePlaintext.fill(0);
  const newPayload = object(
    JSON.parse(string(newMap.__api_runner_job_payload__)),
  );
  assert.equal(object(newPayload.executionContext).extra, 42);
  assert.equal(
    decode(string(object(newPayload.executionContext).encryptedSecrets)).kms
      .keyId,
    target,
  );

  failRewrap = true;
  const failure = await cli(
    "kms-failure",
    ["--migrate", "--preflight", join(directory, "post-resume.json")],
    false,
    true,
  );
  assert.equal(failure.complete, false);
  assert.ok(failure.cursor);
  failRewrap = false;
  await cli("retry", [
    "--migrate",
    "--preflight",
    join(directory, "post-resume.json"),
    "--cursor",
    string(failure.cursor),
  ]);
  const final = await cli("final", ["--verify"]);
  assert.equal(final.databaseVerifiedOnTarget, true);
  const finalClear = await decrypt(
    kms,
    decode(await stored("secrets", "encrypted_value", "01")),
    target,
  );
  assert.equal(finalClear.toString("utf8"), `${secret}-updated`);
  finalClear.fill(0);

  await cli("rollback-preflight", ["--verify"], true);
  await cli(
    "rollback",
    ["--migrate", "--preflight", join(directory, "rollback-preflight.json")],
    true,
  );
  const rollback = await cli("rollback-verify", ["--verify"], true);
  assert.equal(rollback.databaseVerifiedOnTarget, true);
  const rollbackClear = await decrypt(
    kms,
    decode(await stored("secrets", "encrypted_value", "01")),
    source,
  );
  assert.equal(
    rollbackClear.toString("utf8"),
    `${secret}-updated`,
    "Rollback must keep the current value",
  );
  rollbackClear.fill(0);
  const malformed =
    prefix +
    Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "stored-secret",
        kms: {
          keyId: source,
          ciphertext: "c2FmZQ==",
          encryptedDataKey: "partial",
        },
      }),
    ).toString("base64url");
  await db.query("INSERT INTO secrets VALUES ('bad', $1)", [malformed]);
  const invalid = await cli("malformed", [], false, true);
  assert.equal(object(invalid.totals).invalid, 1);
  assert.equal(invalid.databaseVerifiedOnTarget, false);
  process.stdout.write(
    "KMS rotation CLI integration passed: read-only inventory, nested verification, bounded resume, concurrent writes, KMS failure recovery, rewrap preservation, reverse migration, and malformed ciphertext.\n",
  );
} finally {
  kms.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await db.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
