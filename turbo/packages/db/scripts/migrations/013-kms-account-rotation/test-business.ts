#!/usr/bin/env tsx

// Real PostgreSQL fixture writes and HTTP boundaries; no production endpoints.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { Client } from "pg";

import { verifyBusinessCanary } from "./business-canary";
import { decode, encode, object, string } from "./kms";

const input = new URL(string(process.env.DATABASE_URL));
assert.ok(["localhost", "127.0.0.1", "postgres"].includes(input.hostname));
const databaseName = `kms_business_test_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: input.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
input.pathname = `/${databaseName}`;
const db = new Client({ connectionString: input.toString() });
await db.connect();
const source =
  "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8";
const target =
  "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947";
const agent = randomUUID();
const user = "user_canary";
const org = "org_canary";
const values = new Map<string, string>();
function encrypted(plaintext: string, key = target, legacy = false): string {
  const ciphertext = randomBytes(64).toString("base64");
  values.set(ciphertext, plaintext);
  return encode({
    v: 1,
    kind: "stored-secret",
    kms: {
      keyId: key,
      ciphertext,
      ...(legacy
        ? {}
        : {
            encryptedDataKey: randomBytes(64).toString("base64"),
            iv: randomBytes(12).toString("base64"),
            authTag: randomBytes(16).toString("base64"),
          }),
    },
  });
}
let scenario = "success";
let adds = 0;
let reconnects = 0;
let revoked = false;
let clientEnded = false;
let httpFailure: unknown;
const session = "sess_synthetic";
const jwt = `header.${Buffer.from(JSON.stringify({ sub: user, sid: session, o: { id: org } })).toString("base64url")}.signature`;
const server = createServer((request, response) => {
  async function handle(): Promise<void> {
    const url = new URL(string(request.url), "http://localhost");
    const path = url.pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body =
      raw && !path.startsWith("/frontend/") ? object(JSON.parse(raw)) : {};
    let result: Record<string, unknown> = {};
    let status = 200;
    if (path.startsWith("/backend/")) {
      assert.equal(request.headers.authorization, "Bearer sk_live_synthetic");
      if (path.endsWith("/memberships")) {
        assert.equal(url.searchParams.get("user_id"), user);
        result = {
          data: [
            {
              organization: { id: org, slug: "vm0" },
              public_user_data: { user_id: user },
              role: "org:admin",
            },
          ],
        };
      } else if (path.endsWith("/sign_in_tokens")) {
        assert.deepEqual(body, {
          user_id: user,
          org_id: org,
          expires_in_seconds: 60,
        });
        result = {
          id: "sit_synthetic",
          token: "synthetic-ticket-must-not-be-logged",
        };
      } else if (path.endsWith("/tokens")) {
        result = { jwt };
      } else if (path.endsWith("/revoke")) {
        revoked = true;
        result = { id: session, status: "revoked" };
      } else throw new Error("Unhandled Clerk backend route");
    } else if (path.startsWith("/frontend/")) {
      assert.equal(request.headers.authorization, undefined);
      if (path.endsWith("/sign_ins")) {
        assert.equal(request.headers.cookie, "__client=synthetic-cookie");
        assert.equal(new URLSearchParams(raw).get("strategy"), "ticket");
        result = {
          response: { status: "complete", created_session_id: session },
        };
      } else if (request.method === "DELETE") {
        clientEnded = true;
      } else {
        response.setHeader(
          "Set-Cookie",
          "__client=synthetic-cookie; HttpOnly; Path=/",
        );
      }
    } else {
      await deployed();
    }

    async function deployed(): Promise<void> {
      assert.equal(request.headers.authorization, `Bearer ${jwt}`);
      if (path.startsWith("/deployed/api/agents/")) {
        result = { id: agent };
      } else if (request.method === "DELETE") {
        const resourceId = string(path.split("/").at(-1));
        const collection = path.split("/").at(-2);
        const tables: Record<string, string> = {
          "workflow-automations": "workflow_automations",
          "chat-threads": "chat_threads",
          workflows: "workflows",
          "custom-connectors": "org_custom_connectors",
        };
        if (
          scenario === "cleanup-failure" &&
          collection === "custom-connectors"
        ) {
          status = 500;
        } else {
          const table = string(tables[string(collection)]);
          await db.query(`DELETE FROM ${table} WHERE id=$1`, [resourceId]);
          status = 204;
        }
      } else if (path === "/deployed/api/workflows") {
        assert.equal(body.visibility, "private");
        const workflowId = randomUUID();
        await db.query(
          "INSERT INTO workflows VALUES ($1,$2,$3,$4,$5,'private')",
          [workflowId, org, user, agent, body.name],
        );
        result = { id: workflowId };
        status = 201;
      } else if (path.endsWith("/automations")) {
        assert.deepEqual(body, {
          kind: "event",
          eventType: "webhook-received",
          enabled: false,
        });
        const workflowId = path.split("/").at(-2);
        const automationId = randomUUID();
        const threadId = randomUUID();
        await db.query(
          "INSERT INTO workflow_automations VALUES ($1,$2,$3,$4,false,'webhook-received',NULL)",
          [automationId, org, user, workflowId],
        );
        await db.query("INSERT INTO chat_threads VALUES ($1)", [threadId]);
        await db.query(
          "INSERT INTO workflow_user_automation_threads VALUES ($1,$2,$3,$4)",
          [org, user, workflowId, threadId],
        );
        const key = scenario === "wrong-write-key" ? source : target;
        await db.query(
          "INSERT INTO workflow_webhook_automations VALUES ($1,$2,$3,'cret',NULL)",
          [
            automationId,
            encrypted("webhook-token", key),
            encrypted("webhook-secret", key),
          ],
        );
        result = {
          id: automationId,
          webhookUrl: "https://never-called.invalid/webhook-token",
          webhookSecret: "webhook-secret",
        };
        status = 201;
      } else if (path.endsWith("/webhook-secret")) {
        const automationId = path.split("/").at(-2);
        const row = object(
          (
            await db.query(
              "SELECT encrypted_secret FROM workflow_webhook_automations WHERE automation_id=$1",
              [automationId],
            )
          ).rows[0],
        );
        const envelope = decode(string(row.encrypted_secret));
        const plaintext = values.get(envelope.kms.ciphertext);
        assert.ok(plaintext);
        result = {
          webhookUrl: "https://never-called.invalid/webhook-token",
          webhookSecret:
            scenario === "redacted-reader" ||
            (scenario === "update-reader-failure" && reconnects > 0) ||
            (scenario === "legacy-reader-failure" &&
              envelope.kms.encryptedDataKey === undefined)
              ? "********"
              : plaintext,
        };
      } else if (path === "/deployed/api/custom-connectors") {
        assert.deepEqual(body.prefixTemplates, ["https://kms-canary.invalid/"]);
        const customId = randomUUID();
        await db.query(
          "INSERT INTO org_custom_connectors VALUES ($1,$2,$3,$4,$5)",
          [customId, org, user, body.slug, body.displayName],
        );
        result = { id: customId };
        status = scenario === "lost-create-response" ? 500 : 201;
      } else if (path.endsWith("/values")) {
        const customId = path.split("/").at(-2);
        const account = object(body.account);
        assert.ok(Array.isArray(body.values));
        const plaintext = string(object(body.values[0]).value);
        let connectionId: string;
        if (account.intent === "add") {
          adds++;
          connectionId = randomUUID();
          await db.query("INSERT INTO connectors VALUES ($1,$2,$3,$4)", [
            connectionId,
            org,
            user,
            customId,
          ]);
          await db.query(
            "INSERT INTO secrets VALUES ($1,$2,$3,$4,'connector',$5)",
            [randomUUID(), org, user, connectionId, encrypted(plaintext)],
          );
        } else {
          assert.equal(account.intent, "reconnect");
          reconnects++;
          connectionId = string(account.connectionId);
          await db.query(
            "UPDATE secrets SET encrypted_value=$1 WHERE connector_id=$2",
            [encrypted(plaintext), connectionId],
          );
          if (scenario === "fixture-enabled") {
            await db.query(
              "UPDATE workflow_automations SET enabled=true WHERE org_id=$1 AND owner_user_id=$2",
              [org, user],
            );
          }
        }
        result = { connectedAccountId: connectionId };
      } else throw new Error("Unhandled deployed API route");
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(status === 204 ? undefined : JSON.stringify(result));
  }
  handle().catch((error: unknown) => {
    httpFailure = error;
    response.writeHead(500);
    response.end("synthetic-provider-secret-must-not-be-logged");
  });
});

try {
  await db.query(`
    CREATE TABLE workflows(id uuid PRIMARY KEY, org_id text, owner_user_id text, agent_id uuid, name text, visibility text);
    CREATE TABLE workflow_automations(id uuid PRIMARY KEY, org_id text, owner_user_id text, workflow_id uuid REFERENCES workflows(id) ON DELETE CASCADE, enabled boolean, event_type text, last_run_id uuid);
    CREATE TABLE workflow_webhook_automations(automation_id uuid PRIMARY KEY REFERENCES workflow_automations(id) ON DELETE CASCADE, encrypted_token text, encrypted_secret text, secret_last_four text, last_received_at timestamp);
    CREATE TABLE chat_threads(id uuid PRIMARY KEY);
    CREATE TABLE workflow_user_automation_threads(org_id text, user_id text, workflow_id uuid REFERENCES workflows(id) ON DELETE CASCADE, chat_thread_id uuid REFERENCES chat_threads(id) ON DELETE SET NULL);
    CREATE TABLE org_custom_connectors(id uuid PRIMARY KEY, org_id text, created_by text, slug text, display_name text);
    CREATE TABLE connectors(id uuid PRIMARY KEY, org_id text, user_id text, custom_connector_id uuid REFERENCES org_custom_connectors(id) ON DELETE CASCADE);
    CREATE TABLE secrets(id uuid PRIMARY KEY, org_id text, user_id text, connector_id uuid REFERENCES connectors(id) ON DELETE CASCADE, type text, encrypted_value text);
    INSERT INTO secrets VALUES ('00000000-0000-0000-0000-000000000001', 'org_other','user_other',NULL,'user','historical-secret-must-stay-unchanged');
  `);
  await new Promise<void>((resolve) => {
    return server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  for (scenario of [
    "success",
    "redacted-reader",
    "wrong-write-key",
    "lost-create-response",
    "update-reader-failure",
    "legacy-reader-failure",
    "fixture-enabled",
    "cleanup-failure",
  ]) {
    adds = 0;
    reconnects = 0;
    revoked = false;
    clientEnded = false;
    httpFailure = undefined;
    const checkpoints: string[] = [];
    const report = await verifyBusinessCanary(
      {
        databaseUrl: input.toString(),
        apiOrigin: endpoint + "/deployed",
        clerkBackendOrigin: endpoint + "/backend",
        clerkFrontendOrigin: endpoint + "/frontend",
        appOrigin: endpoint,
        clerkSecret: "sk_live_synthetic",
        userId: user,
        orgId: org,
        agentId: agent,
        sourceKey: source,
        targetKey: target,
        oldEnvelope: encrypted("kms-32264-production-synthetic-only", source),
        oldLegacy: encrypted(
          "kms-32264-production-synthetic-only",
          source,
          true,
        ),
      },
      async (checkpoint) => {
        checkpoints.push(JSON.stringify(checkpoint));
      },
    );
    assert.equal(httpFailure, undefined);
    assert.equal(
      report.result,
      scenario === "success" ? "passed" : "failed",
      scenario,
    );
    if (scenario === "success") {
      assert.equal(report.fixtureWrites, 4);
      assert.equal(report.checks.length, 5);
      assert.equal(adds, 1);
      assert.equal(reconnects, 1);
    }
    if (scenario === "fixture-enabled") assert.equal(report.fixtureWrites, 1);
    assert.equal(report.historicalCiphertextWrites, 0);
    assert.ok(revoked && clientEnded, "Only the dedicated login must be ended");
    for (const secret of [
      jwt,
      "sk_live_synthetic",
      "synthetic-cookie",
      "synthetic-ticket-must-not-be-logged",
      "webhook-secret",
      "kms-32264-production-synthetic-only",
      `${report.nonce}-add`,
      `${report.nonce}-reconnect`,
    ]) {
      assert.ok(
        checkpoints.every((checkpoint) => {
          return !checkpoint.includes(secret);
        }),
        "Sanitized checkpoints must not contain secrets",
      );
    }
    const historical = (
      await db.query(
        "SELECT encrypted_value FROM secrets WHERE user_id='user_other'",
      )
    ).rows;
    assert.deepEqual(historical, [
      { encrypted_value: "historical-secret-must-stay-unchanged" },
    ]);
    if (scenario === "cleanup-failure") {
      assert.equal(report.cleanup, "failed");
      assert.ok(report.cleanupFailures.includes("customConnectorId"));
      await db.query("DELETE FROM org_custom_connectors WHERE org_id=$1", [
        org,
      ]);
    } else if (scenario !== "fixture-enabled") {
      assert.equal(report.cleanup, "passed");
    }
    for (const table of [
      "workflows",
      "workflow_automations",
      "workflow_webhook_automations",
      "chat_threads",
      "connectors",
      "org_custom_connectors",
    ]) {
      assert.equal(
        (await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]
          .count,
        0,
        `${scenario}: ${table} cleanup`,
      );
    }
    console.log(`Business canary: ${scenario} passed`);
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    return server.close(() => {
      return resolve();
    });
  });
  await db.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
