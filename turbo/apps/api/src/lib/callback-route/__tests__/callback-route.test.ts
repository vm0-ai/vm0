import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { command, createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../event-consumer/hmac";
import { now } from "../../time";
import { seedAgentRunCallback$ } from "../../../signals/routes/__tests__/helpers/agent-run-callback";
import {
  seedCompose$,
  seedRun$,
} from "../../../signals/routes/__tests__/helpers/zero-usage-insight";
import type { RouteEntry } from "../../../signals/route";

import { callbackPayload$, callbackRoute } from "../callback-route";
import { callbackTestProbeContract } from "./helpers";

const PATH = "/api/__test__/callback-route-probe";
const TEST_CALLBACK_SECRET = "test-callback-secret";

const context = testContext();
const store = createStore();

const probeInner$ = command(({ get }) => {
  const data = get(callbackPayload$);
  return {
    status: 200 as const,
    body: { ok: true as const, runId: data.runId },
  };
});

const probeRoute: RouteEntry = Object.freeze({
  route: callbackTestProbeContract.probe,
  handler: callbackRoute(probeInner$),
});

interface SignedHeaderOptions {
  readonly skipSignature?: boolean;
  readonly skipTimestamp?: boolean;
  readonly staleTimestamp?: boolean;
}

function signedHeaders(
  rawBody: string,
  secret = TEST_CALLBACK_SECRET,
  options: SignedHeaderOptions = {},
): Record<string, string> {
  const ts = options.staleTimestamp
    ? Math.floor(now() / 1000) - 1000
    : Math.floor(now() / 1000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!options.skipSignature) {
    headers["X-VM0-Signature"] = computeHmacSignature(rawBody, secret, ts);
  }
  if (!options.skipTimestamp) {
    headers["X-VM0-Timestamp"] = String(ts);
  }
  return headers;
}

async function seedCallback(): Promise<{
  runId: string;
  callbackId: string;
}> {
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = `user_${randomUUID().slice(0, 8)}`;
  const { composeId } = await store.set(
    seedCompose$,
    { orgId, userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    { orgId, userId, composeId },
    context.signal,
  );
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId,
      url: `http://localhost${PATH}`,
      payload: {},
    },
    context.signal,
  );
  return { runId, callbackId };
}

describe("callbackRoute$ primitive", () => {
  it("returns 400 on invalid JSON body", async () => {
    const app = createApp({
      signal: context.signal,
      routes: [probeRoute],
    });
    const rawBody = "{not-json";

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid JSON body",
    });
  });

  it("returns 400 on missing runId", async () => {
    const app = createApp({
      signal: context.signal,
      routes: [probeRoute],
    });
    const rawBody = JSON.stringify({ status: "completed", payload: {} });

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing runId",
    });
  });

  it("returns 404 on callback not found", async () => {
    const app = createApp({
      signal: context.signal,
      routes: [probeRoute],
    });
    const rawBody = JSON.stringify({
      runId: randomUUID(),
      status: "completed",
      payload: {},
    });

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Callback not found",
    });
  });

  it("returns 401 on invalid signature", async () => {
    const { runId } = await seedCallback();
    const app = createApp({
      signal: context.signal,
      routes: [probeRoute],
    });
    const rawBody = JSON.stringify({ runId, status: "completed", payload: {} });

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody, "wrong-secret"),
      body: rawBody,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid signature",
    });
  });

  it("returns 401 on missing X-VM0-Signature header", async () => {
    const { runId } = await seedCallback();
    const app = createApp({
      signal: context.signal,
      routes: [probeRoute],
    });
    const rawBody = JSON.stringify({ runId, status: "completed", payload: {} });

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody, TEST_CALLBACK_SECRET, {
        skipSignature: true,
      }),
      body: rawBody,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing X-VM0-Signature header",
    });
  });

  it("returns 401 on missing X-VM0-Timestamp header", async () => {
    const { runId } = await seedCallback();
    const app = createApp({
      signal: context.signal,
      routes: [probeRoute],
    });
    const rawBody = JSON.stringify({ runId, status: "completed", payload: {} });

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody, TEST_CALLBACK_SECRET, {
        skipTimestamp: true,
      }),
      body: rawBody,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing X-VM0-Timestamp header",
    });
  });

  it("returns 401 on expired timestamp", async () => {
    const { runId } = await seedCallback();
    const app = createApp({
      signal: context.signal,
      routes: [probeRoute],
    });
    const rawBody = JSON.stringify({ runId, status: "completed", payload: {} });

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody, TEST_CALLBACK_SECRET, {
        staleTimestamp: true,
      }),
      body: rawBody,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Timestamp expired",
    });
  });

  it("invokes the inner handler with the verified callback payload on success", async () => {
    const { runId, callbackId } = await seedCallback();
    const app = createApp({
      signal: context.signal,
      routes: [probeRoute],
    });
    const rawBody = JSON.stringify({
      callbackId,
      runId,
      status: "completed",
      payload: { hello: "world" },
    });

    const response = await app.request(PATH, {
      method: "POST",
      headers: signedHeaders(rawBody),
      body: rawBody,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ ok: true, runId });
  });
});
