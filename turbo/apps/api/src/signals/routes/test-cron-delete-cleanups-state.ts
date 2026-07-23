import { initContract } from "@vm0/api-contracts/contracts/trpc-contract";
import { connectorOauthStates } from "@vm0/db/schema/connector-oauth-state";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { command } from "ccstate";
import { asc, eq, like } from "drizzle-orm";
import { z } from "zod";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const FIXTURE_INSERT_BATCH_SIZE = 5000;
const MAX_EXPIRED_COUNT = 10_001;

const markerSchema = z.string().min(1);
const actionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed-connector"),
    marker: markerSchema,
    cutoff: z.iso.datetime(),
    expiredCount: z.number().int().min(0).max(MAX_EXPIRED_COUNT),
  }),
  z.object({
    action: z.literal("read-connector"),
    marker: markerSchema,
  }),
  z.object({
    action: z.literal("delete-connector"),
    marker: markerSchema,
  }),
  z.object({
    action: z.literal("seed-telegram"),
    marker: markerSchema,
    cutoff: z.iso.datetime(),
    expiredCount: z.number().int().min(0).max(MAX_EXPIRED_COUNT),
  }),
  z.object({
    action: z.literal("read-telegram"),
    marker: markerSchema,
  }),
  z.object({
    action: z.literal("delete-telegram"),
    marker: markerSchema,
  }),
]);

export const testCronDeleteCleanupsStateResponseSchema = z.object({
  ok: z.literal(true),
  remaining: z.array(z.string()),
});

const c = initContract();
export const testCronDeleteCleanupsStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/cron-delete-cleanups-state/action",
    body: actionBodySchema,
    responses: {
      200: testCronDeleteCleanupsStateResponseSchema,
      400: z.object({
        error: z.object({
          code: z.string(),
          message: z.string(),
        }),
      }),
      404: z.string(),
    },
  },
});

export type TestCronDeleteCleanupsStateActionBody = z.infer<
  typeof actionBodySchema
>;
export type TestCronDeleteCleanupsStateResponse = z.infer<
  typeof testCronDeleteCleanupsStateResponseSchema
>;

const actionBody$ = bodyResultOf(testCronDeleteCleanupsStateContract.action);

function connectorState(marker: string, kind: string): string {
  return `${marker}:${kind}`;
}

function telegramMessageId(kind: string, index?: number): string {
  return index === undefined ? kind : `${kind}-${index}`;
}

async function seedConnectorStates(
  db: Db,
  body: Extract<
    TestCronDeleteCleanupsStateActionBody,
    { readonly action: "seed-connector" }
  >,
  signal: AbortSignal,
): Promise<void> {
  const cutoff = new Date(body.cutoff);
  const expiredStart = cutoff.getTime() - 2 * 24 * 60 * 60_000;
  const expiredStates = Array.from(
    { length: body.expiredCount },
    (_, index) => {
      return {
        state: connectorState(body.marker, `expired-${index}`),
        type: "github",
        authMethod: "oauth",
        userId: body.marker,
        orgId: body.marker,
        redirectUri: "https://example.test/oauth/callback",
        expiresAt: new Date(expiredStart + index),
      };
    },
  );
  for (
    let offset = 0;
    offset < expiredStates.length;
    offset += FIXTURE_INSERT_BATCH_SIZE
  ) {
    await db
      .insert(connectorOauthStates)
      .values(expiredStates.slice(offset, offset + FIXTURE_INSERT_BATCH_SIZE));
    signal.throwIfAborted();
  }
  await db.insert(connectorOauthStates).values([
    {
      state: connectorState(body.marker, "equal"),
      type: "github",
      authMethod: "oauth",
      userId: body.marker,
      orgId: body.marker,
      redirectUri: "https://example.test/oauth/callback",
      expiresAt: cutoff,
    },
    {
      state: connectorState(body.marker, "future"),
      type: "github",
      authMethod: "oauth",
      userId: body.marker,
      orgId: body.marker,
      redirectUri: "https://example.test/oauth/callback",
      expiresAt: new Date(cutoff.getTime() + 60 * 60_000),
    },
  ]);
  signal.throwIfAborted();
}

async function readConnectorStates(
  db: Db,
  marker: string,
  signal: AbortSignal,
): Promise<string[]> {
  const rows = await db
    .select({ state: connectorOauthStates.state })
    .from(connectorOauthStates)
    .where(like(connectorOauthStates.state, `${marker}:%`))
    .orderBy(asc(connectorOauthStates.state));
  signal.throwIfAborted();
  return rows.map((row) => {
    return row.state;
  });
}

async function deleteConnectorStates(
  db: Db,
  marker: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(connectorOauthStates)
    .where(like(connectorOauthStates.state, `${marker}:%`));
  signal.throwIfAborted();
}

async function seedTelegramMessages(
  db: Db,
  body: Extract<
    TestCronDeleteCleanupsStateActionBody,
    { readonly action: "seed-telegram" }
  >,
  signal: AbortSignal,
): Promise<void> {
  const cutoff = new Date(body.cutoff);
  const expiredMessages = Array.from(
    { length: body.expiredCount },
    (_, index) => {
      return {
        officialOrgId: body.marker,
        chatId: body.marker,
        messageId: telegramMessageId("expired", index),
        fromUserId: body.marker,
        createdAt: new Date(cutoff.getTime() - 1),
      };
    },
  );
  for (
    let offset = 0;
    offset < expiredMessages.length;
    offset += FIXTURE_INSERT_BATCH_SIZE
  ) {
    await db
      .insert(telegramMessages)
      .values(
        expiredMessages.slice(offset, offset + FIXTURE_INSERT_BATCH_SIZE),
      );
    signal.throwIfAborted();
  }
  await db.insert(telegramMessages).values([
    {
      officialOrgId: body.marker,
      chatId: body.marker,
      messageId: telegramMessageId("equal"),
      fromUserId: body.marker,
      createdAt: cutoff,
    },
    {
      officialOrgId: body.marker,
      chatId: body.marker,
      messageId: telegramMessageId("future"),
      fromUserId: body.marker,
      createdAt: new Date(cutoff.getTime() + 60 * 60_000),
    },
  ]);
  signal.throwIfAborted();
}

async function readTelegramMessages(
  db: Db,
  marker: string,
  signal: AbortSignal,
): Promise<string[]> {
  const rows = await db
    .select({ messageId: telegramMessages.messageId })
    .from(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, marker))
    .orderBy(asc(telegramMessages.messageId));
  signal.throwIfAborted();
  return rows.map((row) => {
    return row.messageId;
  });
}

async function deleteTelegramMessages(
  db: Db,
  marker: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, marker));
  signal.throwIfAborted();
}

function actionOk(remaining: string[] = []) {
  return {
    status: 200 as const,
    body: { ok: true as const, remaining },
  };
}

const mutateTestCronDeleteCleanupsState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "seed-connector": {
        await seedConnectorStates(db, body, signal);
        return actionOk();
      }
      case "read-connector": {
        return actionOk(await readConnectorStates(db, body.marker, signal));
      }
      case "delete-connector": {
        await deleteConnectorStates(db, body.marker, signal);
        return actionOk();
      }
      case "seed-telegram": {
        await seedTelegramMessages(db, body, signal);
        return actionOk();
      }
      case "read-telegram": {
        return actionOk(await readTelegramMessages(db, body.marker, signal));
      }
      case "delete-telegram": {
        await deleteTelegramMessages(db, body.marker, signal);
        return actionOk();
      }
    }
  },
);

export const testCronDeleteCleanupsStateRoutes: readonly RouteEntry[] = [
  {
    route: testCronDeleteCleanupsStateContract.action,
    handler: mutateTestCronDeleteCleanupsState$,
  },
];
