import { DatabaseSync } from "node:sqlite";

import { beforeAll, describe, expect, it } from "vitest";

import worker, { PiThreadDurableObject } from "./index";
import type { SqlCursor, SqlValue, ThreadStoreContext } from "./thread";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const BASE_URL = "https://pi-state.vm0.ai";

let signingKey: CryptoKeyPair;
let foreignKey: CryptoKeyPair;
let publicKeyPem: string;

function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return binary;
}

function spkiToPem(spki: ArrayBuffer): string {
  const base64 = btoa(bytesToBinary(new Uint8Array(spki)));
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function encodeSegment(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

beforeAll(async () => {
  signingKey = await generateKeyPair();
  foreignKey = await generateKeyPair();
  publicKeyPem = spkiToPem(
    await crypto.subtle.exportKey("spki", signingKey.publicKey),
  );
});

interface TokenOptions {
  readonly claims?: Record<string, unknown>;
  readonly header?: Record<string, unknown>;
  readonly privateKey?: CryptoKey;
}

async function createToken(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "vm0-api",
    aud: "vm0-pi-state",
    sub: "thread-1",
    runId: "run-1",
    scopes: ["messages:read", "messages:append"],
    iat: now,
    exp: now + 3600,
    ...options.claims,
  };
  const headerSegment = encodeSegment(
    options.header ?? { alg: "ES256", typ: "JWT" },
  );
  const payloadSegment = encodeSegment(payload);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    options.privateKey ?? signingKey.privateKey,
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  return `${headerSegment}.${payloadSegment}.${bytesToBase64Url(
    new Uint8Array(signature),
  )}`;
}

function createNodeStorage(): ThreadStoreContext {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec<T extends Record<string, SqlValue>>(
        query: string,
        ...bindings: SqlValue[]
      ): SqlCursor<T> {
        const rows = db.prepare(query).all(...bindings) as T[];
        return {
          toArray(): T[] {
            return rows;
          },
        };
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function createTestEnv(): WorkerEnv {
  const objects = new Map<string, PiThreadDurableObject>();
  return {
    TOKEN_PUBLIC_KEY: publicKeyPem,
    PI_THREADS: {
      idFromName(name: string): string {
        return name;
      },
      get(id: { toString(): string }): {
        fetch(request: Request): Promise<Response>;
      } {
        const key = id.toString();
        let instance = objects.get(key);
        if (!instance) {
          instance = new PiThreadDurableObject({
            storage: createNodeStorage(),
          });
          objects.set(key, instance);
        }
        const target = instance;
        return {
          fetch(request: Request): Promise<Response> {
            return target.fetch(request);
          },
        };
      },
    },
  };
}

function readRequest(token: string): Request {
  return new Request(`${BASE_URL}/v1/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function appendRequest(token: string, body: unknown): Request {
  return new Request(`${BASE_URL}/v1/messages/append`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function incomingMessage(
  messageId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    messageId,
    runId: "run-1",
    role: "user",
    payload: { text: `content of ${messageId}` },
    ...overrides,
  };
}

function appendBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    expectedVersion: 1,
    expectedLastOrdinal: 0,
    messages: [incomingMessage("m-1")],
    ...overrides,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("capability token verification", () => {
  it("rejects requests without a bearer token", async () => {
    const env = createTestEnv();
    const response = await worker.fetch(
      new Request(`${BASE_URL}/v1/messages`),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("rejects malformed tokens", async () => {
    const env = createTestEnv();
    const response = await worker.fetch(readRequest("not-a-token"), env);
    expect(response.status).toBe(401);
  });

  it("rejects tokens signed by an unknown key", async () => {
    const env = createTestEnv();
    const token = await createToken({ privateKey: foreignKey.privateKey });
    const response = await worker.fetch(readRequest(token), env);
    expect(response.status).toBe(401);
  });

  it("rejects tokens with the none algorithm", async () => {
    const env = createTestEnv();
    const token = await createToken({ header: { alg: "none", typ: "JWT" } });
    const response = await worker.fetch(readRequest(token), env);
    expect(response.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const env = createTestEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await createToken({
      claims: { iat: now - 600, exp: now - 60 },
    });
    const response = await worker.fetch(readRequest(token), env);
    expect(response.status).toBe(401);
  });

  it("rejects tokens that are not valid yet", async () => {
    const env = createTestEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await createToken({ claims: { nbf: now + 600 } });
    const response = await worker.fetch(readRequest(token), env);
    expect(response.status).toBe(401);
  });

  it("rejects tokens with a lifetime over two hours", async () => {
    const env = createTestEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = await createToken({
      claims: { iat: now, exp: now + 7201 },
    });
    const response = await worker.fetch(readRequest(token), env);
    expect(response.status).toBe(401);
  });

  it("rejects tokens with the wrong issuer or audience", async () => {
    const env = createTestEnv();
    const wrongIssuer = await createToken({ claims: { iss: "someone-else" } });
    const wrongAudience = await createToken({ claims: { aud: "vm0-other" } });
    expect((await worker.fetch(readRequest(wrongIssuer), env)).status).toBe(
      401,
    );
    expect((await worker.fetch(readRequest(wrongAudience), env)).status).toBe(
      401,
    );
  });

  it("rejects tokens without runId or scopes", async () => {
    const env = createTestEnv();
    const missingRunId = await createToken({ claims: { runId: undefined } });
    const missingScopes = await createToken({ claims: { scopes: undefined } });
    expect((await worker.fetch(readRequest(missingRunId), env)).status).toBe(
      401,
    );
    expect((await worker.fetch(readRequest(missingScopes), env)).status).toBe(
      401,
    );
  });
});

describe("routing", () => {
  it("returns 404 outside the /v1 prefix", async () => {
    const env = createTestEnv();
    const response = await worker.fetch(new Request(`${BASE_URL}/health`), env);
    expect(response.status).toBe(404);
  });

  it("returns 404 for unknown /v1 paths", async () => {
    const env = createTestEnv();
    const token = await createToken();
    const response = await worker.fetch(
      new Request(`${BASE_URL}/v1/unknown`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("routes each token subject to its own thread", async () => {
    const env = createTestEnv();
    const threadOne = await createToken();
    const threadTwo = await createToken({ claims: { sub: "thread-2" } });

    const append = await worker.fetch(
      appendRequest(threadOne, appendBody()),
      env,
    );
    expect(append.status).toBe(200);

    const otherThread = await readJson(
      await worker.fetch(readRequest(threadTwo), env),
    );
    expect(otherThread.messages).toEqual([]);

    const sameThread = await readJson(
      await worker.fetch(readRequest(threadOne), env),
    );
    expect(sameThread.messages).toHaveLength(1);
  });

  it("ignores a spoofed capability header from the client", async () => {
    const env = createTestEnv();
    const readOnly = await createToken({
      claims: { scopes: ["messages:read"] },
    });
    const spoofed = new Request(`${BASE_URL}/v1/messages/append`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readOnly}`,
        "Content-Type": "application/json",
        "x-pi-state-capability": JSON.stringify({
          runId: "run-1",
          scopes: ["messages:append"],
        }),
      },
      body: JSON.stringify(appendBody()),
    });
    const response = await worker.fetch(spoofed, env);
    expect(response.status).toBe(403);
  });
});

describe("scope enforcement", () => {
  it("rejects appends with a read-only token", async () => {
    const env = createTestEnv();
    const token = await createToken({ claims: { scopes: ["messages:read"] } });
    const response = await worker.fetch(
      appendRequest(token, appendBody()),
      env,
    );
    expect(response.status).toBe(403);
  });

  it("rejects reads with an append-only token", async () => {
    const env = createTestEnv();
    const token = await createToken({
      claims: { scopes: ["messages:append"] },
    });
    const response = await worker.fetch(readRequest(token), env);
    expect(response.status).toBe(403);
  });
});

describe("append", () => {
  it("appends a batch and reads it back", async () => {
    const env = createTestEnv();
    const token = await createToken();
    const body = appendBody({
      messages: [
        incomingMessage("m-1", { role: "assistant" }),
        incomingMessage("m-2", { role: "toolResult" }),
      ],
    });

    const append = await worker.fetch(appendRequest(token, body), env);
    expect(append.status).toBe(200);
    expect(await readJson(append)).toEqual({ version: 1, lastOrdinal: 2 });

    const read = await readJson(await worker.fetch(readRequest(token), env));
    expect(read.version).toBe(1);
    expect(read.lastOrdinal).toBe(2);
    const messages = read.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      ordinal: 1,
      messageId: "m-1",
      runId: "run-1",
      role: "assistant",
      payload: { text: "content of m-1" },
    });
    expect(messages[1]).toMatchObject({ ordinal: 2, messageId: "m-2" });
    expect(typeof messages[0]?.createdAt).toBe("number");
  });

  it("continues ordinals across batches", async () => {
    const env = createTestEnv();
    const token = await createToken();
    await worker.fetch(appendRequest(token, appendBody()), env);
    const second = await worker.fetch(
      appendRequest(
        token,
        appendBody({
          expectedLastOrdinal: 1,
          messages: [incomingMessage("m-2")],
        }),
      ),
      env,
    );
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({ version: 1, lastOrdinal: 2 });
  });

  it("rejects appends against a stale head", async () => {
    const env = createTestEnv();
    const token = await createToken();
    await worker.fetch(appendRequest(token, appendBody()), env);
    const stale = await worker.fetch(
      appendRequest(token, appendBody({ messages: [incomingMessage("m-2")] })),
      env,
    );
    expect(stale.status).toBe(409);
    expect(await readJson(stale)).toEqual({
      error: "head_conflict",
      version: 1,
      lastOrdinal: 1,
    });
  });

  it("treats an identical retried batch as an idempotent replay", async () => {
    const env = createTestEnv();
    const token = await createToken();
    const body = appendBody({
      messages: [incomingMessage("m-1"), incomingMessage("m-2")],
    });
    const first = await worker.fetch(appendRequest(token, body), env);
    expect(first.status).toBe(200);

    const retry = await worker.fetch(appendRequest(token, body), env);
    expect(retry.status).toBe(200);
    expect(await readJson(retry)).toEqual({
      version: 1,
      lastOrdinal: 2,
      replayed: true,
    });

    const read = await readJson(await worker.fetch(readRequest(token), env));
    expect(read.messages).toHaveLength(2);
  });

  it("rejects reusing a message id with different content", async () => {
    const env = createTestEnv();
    const token = await createToken();
    await worker.fetch(appendRequest(token, appendBody()), env);
    const conflicting = await worker.fetch(
      appendRequest(
        token,
        appendBody({
          messages: [incomingMessage("m-1", { payload: { text: "changed" } })],
        }),
      ),
      env,
    );
    expect(conflicting.status).toBe(409);
    expect(await readJson(conflicting)).toEqual({
      error: "message_conflict",
      messageId: "m-1",
    });
  });

  it("rejects a batch mixing replayed and new messages", async () => {
    const env = createTestEnv();
    const token = await createToken();
    await worker.fetch(appendRequest(token, appendBody()), env);
    const mixed = await worker.fetch(
      appendRequest(
        token,
        appendBody({
          expectedLastOrdinal: 1,
          messages: [incomingMessage("m-1"), incomingMessage("m-2")],
        }),
      ),
      env,
    );
    expect(mixed.status).toBe(409);
    expect(await readJson(mixed)).toEqual({
      error: "message_conflict",
      messageId: "m-1",
    });
  });

  it("rejects messages belonging to another run", async () => {
    const env = createTestEnv();
    const token = await createToken();
    const response = await worker.fetch(
      appendRequest(
        token,
        appendBody({
          messages: [incomingMessage("m-1", { runId: "run-2" })],
        }),
      ),
      env,
    );
    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({
      error: "run_mismatch",
      messageId: "m-1",
    });
  });

  it("allows foreign run ids with the import scope", async () => {
    const env = createTestEnv();
    const importToken = await createToken({
      claims: {
        scopes: ["messages:read", "messages:append", "messages:import"],
      },
    });
    const response = await worker.fetch(
      appendRequest(
        importToken,
        appendBody({
          messages: [incomingMessage("m-1", { runId: "historical-run" })],
        }),
      ),
      env,
    );
    expect(response.status).toBe(200);

    const read = await readJson(
      await worker.fetch(readRequest(importToken), env),
    );
    const messages = read.messages as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({ runId: "historical-run" });
  });

  it("lets a later run append to and read the same thread", async () => {
    const env = createTestEnv();
    const runOne = await createToken();
    const runTwo = await createToken({ claims: { runId: "run-2" } });

    await worker.fetch(appendRequest(runOne, appendBody()), env);
    const append = await worker.fetch(
      appendRequest(
        runTwo,
        appendBody({
          expectedLastOrdinal: 1,
          messages: [incomingMessage("m-2", { runId: "run-2" })],
        }),
      ),
      env,
    );
    expect(append.status).toBe(200);

    const read = await readJson(await worker.fetch(readRequest(runTwo), env));
    const messages = read.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ runId: "run-1" });
    expect(messages[1]).toMatchObject({ runId: "run-2" });
  });

  it("rejects invalid append payloads", async () => {
    const env = createTestEnv();
    const token = await createToken();
    const invalidBodies: unknown[] = [
      {},
      appendBody({ expectedVersion: 0 }),
      appendBody({ expectedLastOrdinal: -1 }),
      appendBody({ expectedLastOrdinal: 0.5 }),
      appendBody({ messages: [] }),
      appendBody({ messages: [{ runId: "run-1", role: "user" }] }),
      appendBody({ messages: [incomingMessage("m-1", { role: "" })] }),
    ];
    for (const body of invalidBodies) {
      const response = await worker.fetch(appendRequest(token, body), env);
      expect(response.status).toBe(400);
    }

    const invalidJson = await worker.fetch(
      new Request(`${BASE_URL}/v1/messages/append`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{",
      }),
      env,
    );
    expect(invalidJson.status).toBe(400);
  });

  it("rejects oversized payloads", async () => {
    const env = createTestEnv();
    const token = await createToken();
    const response = await worker.fetch(
      appendRequest(
        token,
        appendBody({
          messages: [
            incomingMessage("m-1", {
              payload: { text: "x".repeat(1_048_577) },
            }),
          ],
        }),
      ),
      env,
    );
    expect(response.status).toBe(413);
    expect(await readJson(response)).toEqual({
      error: "payload_too_large",
      messageId: "m-1",
    });
  });
});
