import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  notionChildPageCreatedEventConfigSchema,
  type NotionChildPageCreatedEventConfig,
  type NotionChildPageCreatedEventCreateConfig,
  type NotionPageReference,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { refreshNotionToken } from "@vm0/connectors/auth-providers/connectors/notion/oauth";
import { connectors } from "@vm0/db/schema/connector";
import {
  notionWebhookEvents,
  notionWebhookSecrets,
  notionWorkflowPendingEvents,
} from "@vm0/db/schema/notion-event";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { now, nowDate } from "../external/time";
import { safeJsonParse, safeUrlParse, settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  buildChatOnlyWorkflowTriggerCallbacks,
  runWorkflowTriggerNow$,
  type RunWorkflowTriggerNowArgs,
  type RunWorkflowTriggerResult,
  type TriggerRow,
} from "./zero-workflow-trigger-run.service";

const NOTION_ACCESS_TOKEN_SECRET = "NOTION_ACCESS_TOKEN";
const NOTION_REFRESH_TOKEN_SECRET = "NOTION_REFRESH_TOKEN";
const CONNECTOR_SECRET_TYPE = "connector";
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const NOTION_CHILD_PAGE_SETTLE_MS = 15 * 60 * 1000;
const NOTION_PENDING_RETRY_MS = 5 * 60 * 1000;
const NOTION_PENDING_MAX_ATTEMPTS = 8;
const NOTION_PENDING_BATCH_SIZE = 25;
const NOTION_CHILD_PAGE_MOVED_SKIP_REASON =
  "Notion page is no longer a direct child of the configured parent";

const notionAuthorSchema = z
  .object({
    id: z.string(),
    type: z.enum(["person", "bot", "agent"]),
  })
  .passthrough();

const notionEntitySchema = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
  })
  .passthrough();

const notionParentDataSchema = z
  .object({
    id: z.string(),
    type: z.string(),
  })
  .passthrough();

const notionWebhookVerificationSchema = z
  .object({
    verification_token: z.string().min(1),
  })
  .passthrough();

const notionWebhookEventSchema = z
  .object({
    id: z.string().uuid(),
    timestamp: z.string().datetime(),
    workspace_id: z.string().uuid(),
    workspace_name: z.string().optional(),
    subscription_id: z.string().uuid(),
    integration_id: z.string().uuid(),
    type: z.enum([
      "page.created",
      "page.content_updated",
      "page.properties_updated",
    ]),
    authors: z.array(notionAuthorSchema).default([]),
    attempt_number: z.number().int().positive().optional(),
    entity: notionEntitySchema,
    data: z
      .object({
        parent: notionParentDataSchema.optional(),
      })
      .passthrough()
      .default({}),
  })
  .passthrough();

const notionPageParentSchema = z.union([
  z.object({ type: z.literal("page_id"), page_id: z.string().uuid() }),
  z.object({ type: z.literal("database_id"), database_id: z.string().uuid() }),
  z.object({ type: z.literal("block_id"), block_id: z.string().uuid() }),
  z.object({ type: z.literal("workspace") }).passthrough(),
]);

const notionPageResponseSchema = z
  .object({
    object: z.literal("page"),
    id: z.string().uuid(),
    created_time: z.string().datetime().optional(),
    last_edited_time: z.string().datetime().optional(),
    archived: z.boolean().optional(),
    in_trash: z.boolean().optional(),
    url: z.string().url().optional(),
    parent: notionPageParentSchema,
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type NotionWebhookEvent = z.infer<typeof notionWebhookEventSchema>;
type NotionPageResponse = z.infer<typeof notionPageResponseSchema>;
type NotionPendingRow = typeof notionWorkflowPendingEvents.$inferSelect;

interface ConnectorSecretRow {
  readonly name: string;
  readonly encryptedValue: string;
}

interface NotionConnectorAccessRow {
  readonly id: string;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
}

interface NotionConnectorSecrets {
  readonly accessSecret: ConnectorSecretRow | null;
  readonly refreshSecret: ConnectorSecretRow | null;
}

interface NotionAccess {
  readonly connectorId: string;
  readonly accessToken: string;
}

type NotionAccessResult =
  | { readonly kind: "ok"; readonly access: NotionAccess }
  | { readonly kind: "bad_request"; readonly message: string };

type NotionFetchResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "unauthorized" }
  | {
      readonly kind: "transient_error";
      readonly status: number | null;
      readonly message: string;
    };

type NotionWebhookDispatchResult =
  | {
      readonly kind: "ok";
      readonly webhookKind: "verification" | "event";
      readonly pending: number;
      readonly refreshed: number;
      readonly duplicates: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "config_error"; readonly message: string };

type ExecuteDueNotionEventsResult = {
  readonly executed: number;
  readonly skipped: number;
};

type DueNotionTriggerRow = {
  readonly trigger: TriggerRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string | null;
};
type NotionRunStarter = (
  args: RunWorkflowTriggerNowArgs,
  signal: AbortSignal,
) => Promise<RunWorkflowTriggerResult>;

function tokenNeedsRefresh(tokenExpiresAt: Date | null, currentTime: Date) {
  if (tokenExpiresAt === null) {
    return true;
  }
  return (
    tokenExpiresAt.getTime() <= currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS
  );
}

function tokenExpiresAtFromExpiresIn(
  expiresIn: number | undefined,
  currentTime: Date,
): Date | null {
  return expiresIn === undefined
    ? null
    : new Date(currentTime.getTime() + expiresIn * 1000);
}

function normalizeNotionUuid(value: string): string | null {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    return null;
  }
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function parseStandardNotionPageUrl(value: string): string | null {
  const url = safeUrlParse(value.trim());
  if (!url) {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  if (url.hostname !== "notion.so" && url.hostname !== "www.notion.so") {
    return null;
  }

  const path = url.pathname.replace(/\/+$/, "");
  const match = path.match(
    /([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,
  );
  return match ? normalizeNotionUuid(match[1]!) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notionTitleFromProperties(
  properties: Record<string, unknown> | undefined,
): string | null {
  for (const property of Object.values(properties ?? {})) {
    if (!isRecord(property) || property.type !== "title") {
      continue;
    }
    const titleItems = property.title;
    if (!Array.isArray(titleItems)) {
      continue;
    }
    const title = titleItems
      .flatMap((item) => {
        if (!isRecord(item)) {
          return [];
        }
        const plainText = item.plain_text;
        return typeof plainText === "string" ? [plainText] : [];
      })
      .join("")
      .trim();
    if (title.length > 0) {
      return title;
    }
  }
  return null;
}

function notionPageReference(
  page: NotionPageResponse,
  rawUrl?: string,
): NotionPageReference {
  return {
    id: page.id,
    url: page.url ?? rawUrl ?? `https://www.notion.so/${page.id}`,
    title: notionTitleFromProperties(page.properties),
    ...(rawUrl ? { rawUrl } : {}),
  };
}

function notionPageParentPageId(page: NotionPageResponse): string | null {
  return page.parent.type === "page_id" ? page.parent.page_id : null;
}

function pageIsUsable(page: NotionPageResponse): boolean {
  return page.archived !== true && page.in_trash !== true;
}

async function loadNotionConnector(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId?: string;
  readonly signal: AbortSignal;
}): Promise<NotionConnectorAccessRow | null> {
  const connectorConditions = [
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.type, "notion"),
  ];
  if (args.connectorId !== undefined) {
    connectorConditions.push(eq(connectors.id, args.connectorId));
  }

  const [connector] = await args.db
    .select({
      id: connectors.id,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
    })
    .from(connectors)
    .where(and(...connectorConditions))
    .limit(1);
  args.signal.throwIfAborted();
  return connector ?? null;
}

async function loadNotionConnectorSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<NotionConnectorSecrets> {
  const secretRows = await args.db
    .select({
      name: secretsTable.name,
      encryptedValue: secretsTable.encryptedValue,
    })
    .from(secretsTable)
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.type, CONNECTOR_SECRET_TYPE),
      ),
    );
  args.signal.throwIfAborted();
  return {
    accessSecret:
      secretRows.find((row) => {
        return row.name === NOTION_ACCESS_TOKEN_SECRET;
      }) ?? null,
    refreshSecret:
      secretRows.find((row) => {
        return row.name === NOTION_REFRESH_TOKEN_SECRET;
      }) ?? null,
  };
}

async function markNotionConnectorNeedsReconnect(args: {
  readonly db: Db;
  readonly connectorId: string;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<void> {
  await args.db
    .update(connectors)
    .set({ needsReconnect: true, updatedAt: args.currentTime })
    .where(eq(connectors.id, args.connectorId));
  args.signal.throwIfAborted();
}

async function refreshNotionAccessToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connector: NotionConnectorAccessRow;
  readonly refreshSecret: ConnectorSecretRow;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<NotionAccessResult> {
  const clientId = optionalEnv("NOTION_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("NOTION_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return {
      kind: "bad_request",
      message: "Notion OAuth client env vars are not configured",
    };
  }

  const refreshToken = await decryptStoredSecretValue(
    args.refreshSecret.encryptedValue,
  );
  const refreshResult = await settle(
    refreshNotionToken(clientId, clientSecret, refreshToken, args.signal),
    args.signal,
  );
  if (!refreshResult.ok) {
    await markNotionConnectorNeedsReconnect({
      db: args.db,
      connectorId: args.connector.id,
      currentTime: args.currentTime,
      signal: args.signal,
    });
    return {
      kind: "bad_request",
      message: "Reconnect Notion before using Notion event triggers",
    };
  }

  const tokenExpiresAt = tokenExpiresAtFromExpiresIn(
    refreshResult.value.expiresIn,
    args.currentTime,
  );
  await args.db
    .update(secretsTable)
    .set({
      encryptedValue: await encryptStoredSecretValue(
        refreshResult.value.accessToken,
      ),
      updatedAt: args.currentTime,
    })
    .where(
      and(
        eq(secretsTable.orgId, args.orgId),
        eq(secretsTable.userId, args.userId),
        eq(secretsTable.type, CONNECTOR_SECRET_TYPE),
        eq(secretsTable.name, NOTION_ACCESS_TOKEN_SECRET),
      ),
    );
  args.signal.throwIfAborted();

  if (refreshResult.value.refreshToken) {
    await args.db
      .update(secretsTable)
      .set({
        encryptedValue: await encryptStoredSecretValue(
          refreshResult.value.refreshToken,
        ),
        updatedAt: args.currentTime,
      })
      .where(
        and(
          eq(secretsTable.orgId, args.orgId),
          eq(secretsTable.userId, args.userId),
          eq(secretsTable.type, CONNECTOR_SECRET_TYPE),
          eq(secretsTable.name, NOTION_REFRESH_TOKEN_SECRET),
        ),
      );
    args.signal.throwIfAborted();
  }

  await args.db
    .update(connectors)
    .set({
      tokenExpiresAt,
      needsReconnect: false,
      updatedAt: args.currentTime,
    })
    .where(eq(connectors.id, args.connector.id));
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    access: {
      connectorId: args.connector.id,
      accessToken: refreshResult.value.accessToken,
    },
  };
}

async function resolveNotionAccess(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId?: string;
  readonly signal: AbortSignal;
}): Promise<NotionAccessResult> {
  const currentTime = nowDate();
  const connector = await loadNotionConnector(args);
  if (!connector) {
    return {
      kind: "bad_request",
      message: "Connect Notion before adding a Notion event trigger",
    };
  }
  if (connector.needsReconnect) {
    return {
      kind: "bad_request",
      message: "Reconnect Notion before using Notion event triggers",
    };
  }

  const { accessSecret, refreshSecret } =
    await loadNotionConnectorSecrets(args);
  if (!accessSecret) {
    return {
      kind: "bad_request",
      message: "Reconnect Notion before using Notion event triggers",
    };
  }

  if (!tokenNeedsRefresh(connector.tokenExpiresAt, currentTime)) {
    return {
      kind: "ok",
      access: {
        connectorId: connector.id,
        accessToken: await decryptStoredSecretValue(
          accessSecret.encryptedValue,
        ),
      },
    };
  }

  if (!refreshSecret) {
    await markNotionConnectorNeedsReconnect({
      db: args.db,
      connectorId: connector.id,
      currentTime,
      signal: args.signal,
    });
    return {
      kind: "bad_request",
      message: "Reconnect Notion before using Notion event triggers",
    };
  }

  return await refreshNotionAccessToken({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    connector,
    refreshSecret,
    currentTime,
    signal: args.signal,
  });
}

async function notionFetchJson<T>(
  schema: z.ZodType<T>,
  accessToken: string,
  url: string,
  signal: AbortSignal,
): Promise<NotionFetchResult<T>> {
  const responseResult = await settle(
    fetch(url, {
      method: "GET",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": NOTION_VERSION,
      },
    }),
    signal,
  );
  if (!responseResult.ok) {
    return {
      kind: "transient_error",
      status: null,
      message: "Failed to reach Notion API",
    };
  }

  const response = responseResult.value;
  if (response.status === 401) {
    return { kind: "unauthorized" };
  }
  if (response.status === 403 || response.status === 404) {
    return { kind: "not_found" };
  }
  if (!response.ok) {
    return {
      kind: "transient_error",
      status: response.status,
      message: await response.text(),
    };
  }

  const jsonResult = await settle(response.json() as Promise<unknown>, signal);
  if (!jsonResult.ok) {
    return {
      kind: "transient_error",
      status: response.status,
      message: "Failed to parse Notion API response",
    };
  }
  const parsed = schema.safeParse(jsonResult.value);
  if (!parsed.success) {
    return {
      kind: "transient_error",
      status: response.status,
      message: "Unexpected Notion API response",
    };
  }
  return { kind: "ok", value: parsed.data };
}

async function retrieveNotionPage(args: {
  readonly accessToken: string;
  readonly pageId: string;
  readonly signal: AbortSignal;
}): Promise<NotionFetchResult<NotionPageResponse>> {
  return await notionFetchJson(
    notionPageResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/pages/${args.pageId}`,
    args.signal,
  );
}

export async function prepareNotionChildPageEventConfigForPersist(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly eventConfig: NotionChildPageCreatedEventCreateConfig;
    readonly signal: AbortSignal;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: NotionChildPageCreatedEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const parentPageId = parseStandardNotionPageUrl(
    args.eventConfig.parentPageUrl,
  );
  if (!parentPageId) {
    return {
      kind: "bad-request",
      message: "Enter a standard notion.so page URL",
    };
  }

  const accessResult = await resolveNotionAccess({
    db,
    orgId: args.orgId,
    userId: args.userId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return { kind: "bad-request", message: accessResult.message };
  }

  const pageResult = await retrieveNotionPage({
    accessToken: accessResult.access.accessToken,
    pageId: parentPageId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (pageResult.kind === "not_found" || pageResult.kind === "unauthorized") {
    return {
      kind: "bad-request",
      message: "Zero cannot access this Notion page",
    };
  }
  if (pageResult.kind !== "ok") {
    return {
      kind: "bad-request",
      message: "Failed to validate Notion page URL",
    };
  }
  if (!pageIsUsable(pageResult.value)) {
    return {
      kind: "bad-request",
      message: "Notion page is archived or in trash",
    };
  }

  return {
    kind: "ok",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      connectorId: accessResult.access.connectorId,
      parentPage: notionPageReference(
        pageResult.value,
        args.eventConfig.parentPageUrl,
      ),
    },
  };
}

async function storeVerificationToken(args: {
  readonly db: Db;
  readonly token: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const currentTime = nowDate();
  await args.db
    .update(notionWebhookSecrets)
    .set({ active: false, updatedAt: currentTime })
    .where(eq(notionWebhookSecrets.active, true));
  args.signal.throwIfAborted();
  await args.db.insert(notionWebhookSecrets).values({
    encryptedVerificationToken: await encryptStoredSecretValue(args.token),
    active: true,
    createdAt: currentTime,
    updatedAt: currentTime,
  });
  args.signal.throwIfAborted();
}

async function activeVerificationTokenExists(args: {
  readonly db: ReadonlyDb;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const rows = await args.db
    .select({ id: notionWebhookSecrets.id })
    .from(notionWebhookSecrets)
    .where(eq(notionWebhookSecrets.active, true))
    .limit(1);
  args.signal.throwIfAborted();
  return rows.length > 0;
}

async function loadActiveVerificationTokens(args: {
  readonly db: ReadonlyDb;
  readonly signal: AbortSignal;
}): Promise<readonly string[]> {
  const rows = await args.db
    .select({
      encryptedVerificationToken:
        notionWebhookSecrets.encryptedVerificationToken,
    })
    .from(notionWebhookSecrets)
    .where(eq(notionWebhookSecrets.active, true))
    .orderBy(desc(notionWebhookSecrets.createdAt));
  args.signal.throwIfAborted();
  return await Promise.all(
    rows.map((row) => {
      return decryptStoredSecretValue(row.encryptedVerificationToken);
    }),
  );
}

function signatureMatches(args: {
  readonly rawBody: string;
  readonly signature: string;
  readonly token: string;
}): boolean {
  const calculated = `sha256=${createHmac("sha256", args.token)
    .update(args.rawBody)
    .digest("hex")}`;
  const calculatedBuffer = Buffer.from(calculated);
  const signatureBuffer = Buffer.from(args.signature);
  return (
    calculatedBuffer.byteLength === signatureBuffer.byteLength &&
    timingSafeEqual(calculatedBuffer, signatureBuffer)
  );
}

function verifyNotionSignature(args: {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly tokens: readonly string[];
}): boolean {
  const signature = args.signature;
  if (!signature) {
    return false;
  }
  return args.tokens.some((token) => {
    return signatureMatches({
      rawBody: args.rawBody,
      signature,
      token,
    });
  });
}

function eventPageParentId(event: NotionWebhookEvent): string | null {
  const parent = event.data.parent;
  if (!parent || parent.type !== "page") {
    return null;
  }
  return normalizeNotionUuid(parent.id);
}

function eventPageId(event: NotionWebhookEvent): string | null {
  return event.entity.type === "page"
    ? normalizeNotionUuid(event.entity.id)
    : null;
}

function eventTimestamp(event: NotionWebhookEvent): Date {
  return new Date(event.timestamp);
}

function runAfterForEvent(event: NotionWebhookEvent): Date {
  return new Date(
    eventTimestamp(event).getTime() + NOTION_CHILD_PAGE_SETTLE_MS,
  );
}

async function insertNotionWebhookEvent(args: {
  readonly db: Db;
  readonly event: NotionWebhookEvent;
  readonly pageId: string | null;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const [inserted] = await args.db
    .insert(notionWebhookEvents)
    .values({
      notionEventId: args.event.id,
      eventType: args.event.type,
      pageId: args.pageId,
      receivedAt: nowDate(),
      createdAt: nowDate(),
    })
    .onConflictDoNothing()
    .returning({ id: notionWebhookEvents.id });
  args.signal.throwIfAborted();
  return inserted !== undefined;
}

async function loadNotionChildPageTriggers(args: {
  readonly db: Db;
  readonly signal: AbortSignal;
}): Promise<readonly TriggerRow[]> {
  const rows = await args.db
    .select()
    .from(zeroWorkflowTriggers)
    .where(
      and(
        eq(zeroWorkflowTriggers.kind, "event"),
        eq(zeroWorkflowTriggers.enabled, true),
        eq(zeroWorkflowTriggers.eventType, "notion-child-page-created"),
      ),
    );
  args.signal.throwIfAborted();
  return rows;
}

async function enqueueNotionChildPageEvents(args: {
  readonly db: Db;
  readonly event: NotionWebhookEvent;
  readonly pageId: string;
  readonly parentPageId: string;
  readonly signal: AbortSignal;
}): Promise<number> {
  const triggers = await loadNotionChildPageTriggers(args);
  let pending = 0;
  for (const trigger of triggers) {
    const config = notionChildPageCreatedEventConfigSchema.safeParse(
      trigger.eventConfig,
    );
    if (!config.success || config.data.parentPage.id !== args.parentPageId) {
      continue;
    }
    const [inserted] = await args.db
      .insert(notionWorkflowPendingEvents)
      .values({
        triggerId: trigger.id,
        pageId: args.pageId,
        parentPageId: args.parentPageId,
        eventFamily: "new_child_page",
        status: "pending",
        firstNotionEventId: args.event.id,
        latestNotionEventId: args.event.id,
        firstEventAt: eventTimestamp(args.event),
        latestEventAt: eventTimestamp(args.event),
        runAfter: runAfterForEvent(args.event),
        parentTitle: config.data.parentPage.title,
        parentUrl: config.data.parentPage.url,
        createdAt: nowDate(),
        updatedAt: nowDate(),
      })
      .onConflictDoNothing()
      .returning({ id: notionWorkflowPendingEvents.id });
    args.signal.throwIfAborted();
    if (inserted) {
      pending += 1;
    }
  }
  return pending;
}

async function refreshPendingNotionChildPageEvents(args: {
  readonly db: Db;
  readonly event: NotionWebhookEvent;
  readonly pageId: string;
  readonly signal: AbortSignal;
}): Promise<number> {
  const refreshed = await args.db
    .update(notionWorkflowPendingEvents)
    .set({
      latestNotionEventId: args.event.id,
      latestEventAt: eventTimestamp(args.event),
      runAfter: runAfterForEvent(args.event),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(notionWorkflowPendingEvents.pageId, args.pageId),
        eq(notionWorkflowPendingEvents.status, "pending"),
        eq(notionWorkflowPendingEvents.eventFamily, "new_child_page"),
      ),
    )
    .returning({ id: notionWorkflowPendingEvents.id });
  args.signal.throwIfAborted();
  return refreshed.length;
}

async function dispatchNotionEvent(args: {
  readonly db: Db;
  readonly event: NotionWebhookEvent;
  readonly signal: AbortSignal;
}): Promise<{
  readonly pending: number;
  readonly refreshed: number;
  readonly duplicates: number;
}> {
  const pageId = eventPageId(args.event);
  if (!pageId) {
    return { pending: 0, refreshed: 0, duplicates: 0 };
  }

  const inserted = await insertNotionWebhookEvent({
    db: args.db,
    event: args.event,
    pageId,
    signal: args.signal,
  });
  if (!inserted) {
    return { pending: 0, refreshed: 0, duplicates: 1 };
  }

  if (args.event.type === "page.created") {
    const parentPageId = eventPageParentId(args.event);
    if (!parentPageId) {
      return { pending: 0, refreshed: 0, duplicates: 0 };
    }
    return {
      pending: await enqueueNotionChildPageEvents({
        db: args.db,
        event: args.event,
        pageId,
        parentPageId,
        signal: args.signal,
      }),
      refreshed: 0,
      duplicates: 0,
    };
  }

  return {
    pending: 0,
    refreshed: await refreshPendingNotionChildPageEvents({
      db: args.db,
      event: args.event,
      pageId,
      signal: args.signal,
    }),
    duplicates: 0,
  };
}

export const dispatchNotionWebhook$ = command(
  async (
    { set },
    args: {
      readonly rawBody: string;
      readonly signature: string | null;
    },
    signal: AbortSignal,
  ): Promise<NotionWebhookDispatchResult> => {
    const rawJson = safeJsonParse(args.rawBody);
    if (rawJson === undefined) {
      return { kind: "bad_request", message: "Invalid Notion webhook payload" };
    }

    const verification = notionWebhookVerificationSchema.safeParse(rawJson);
    const db = set(writeDb$);
    if (verification.success) {
      if (await activeVerificationTokenExists({ db, signal })) {
        return { kind: "unauthorized" };
      }
      await storeVerificationToken({
        db,
        token: verification.data.verification_token,
        signal,
      });
      return {
        kind: "ok",
        webhookKind: "verification",
        pending: 0,
        refreshed: 0,
        duplicates: 0,
      };
    }

    const tokens = await loadActiveVerificationTokens({ db, signal });
    if (tokens.length === 0) {
      return {
        kind: "config_error",
        message: "Notion webhook verification token is not configured",
      };
    }
    if (
      !verifyNotionSignature({
        rawBody: args.rawBody,
        signature: args.signature,
        tokens,
      })
    ) {
      return { kind: "unauthorized" };
    }

    const event = notionWebhookEventSchema.safeParse(rawJson);
    if (!event.success) {
      return { kind: "bad_request", message: "Invalid Notion webhook event" };
    }

    const result = await dispatchNotionEvent({
      db,
      event: event.data,
      signal,
    });
    return {
      kind: "ok",
      webhookKind: "event",
      pending: result.pending,
      refreshed: result.refreshed,
      duplicates: result.duplicates,
    };
  },
);

async function loadDueNotionPendingEvents(args: {
  readonly db: Db;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<readonly NotionPendingRow[]> {
  const rows = await args.db
    .select()
    .from(notionWorkflowPendingEvents)
    .where(
      and(
        eq(notionWorkflowPendingEvents.status, "pending"),
        lte(notionWorkflowPendingEvents.runAfter, args.currentTime),
      ),
    )
    .orderBy(asc(notionWorkflowPendingEvents.runAfter))
    .limit(NOTION_PENDING_BATCH_SIZE);
  args.signal.throwIfAborted();
  return rows;
}

async function claimNotionPendingEvent(args: {
  readonly db: Db;
  readonly pending: NotionPendingRow;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<NotionPendingRow | null> {
  const [claimed] = await args.db
    .update(notionWorkflowPendingEvents)
    .set({
      status: "running",
      attempts: sql<number>`${notionWorkflowPendingEvents.attempts} + 1`,
      updatedAt: args.currentTime,
    })
    .where(
      and(
        eq(notionWorkflowPendingEvents.id, args.pending.id),
        eq(notionWorkflowPendingEvents.status, "pending"),
        lte(notionWorkflowPendingEvents.runAfter, args.currentTime),
      ),
    )
    .returning();
  args.signal.throwIfAborted();
  return claimed ?? null;
}

async function loadDueNotionTriggerRow(args: {
  readonly db: Db;
  readonly triggerId: string;
  readonly signal: AbortSignal;
}): Promise<DueNotionTriggerRow | null> {
  const [row] = await args.db
    .select({
      trigger: zeroWorkflowTriggers,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      chatThreadId: workflowUserTriggerThreads.chatThreadId,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
    )
    .leftJoin(
      workflowUserTriggerThreads,
      and(
        eq(workflowUserTriggerThreads.orgId, zeroWorkflowTriggers.orgId),
        eq(workflowUserTriggerThreads.userId, zeroWorkflowTriggers.ownerUserId),
        eq(
          workflowUserTriggerThreads.workflowId,
          zeroWorkflowTriggers.workflowId,
        ),
      ),
    )
    .where(eq(zeroWorkflowTriggers.id, args.triggerId))
    .limit(1);
  args.signal.throwIfAborted();
  return row ?? null;
}

async function skipPendingEvent(args: {
  readonly db: Db;
  readonly pendingId: string;
  readonly reason: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  await args.db
    .update(notionWorkflowPendingEvents)
    .set({
      status: "skipped",
      skipReason: args.reason,
      processedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(eq(notionWorkflowPendingEvents.id, args.pendingId));
  args.signal.throwIfAborted();
}

async function retryPendingEvent(args: {
  readonly db: Db;
  readonly pending: NotionPendingRow;
  readonly message: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.pending.attempts >= NOTION_PENDING_MAX_ATTEMPTS) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: args.message,
      signal: args.signal,
    });
    return;
  }
  await args.db
    .update(notionWorkflowPendingEvents)
    .set({
      status: "pending",
      lastError: args.message,
      runAfter: new Date(now() + NOTION_PENDING_RETRY_MS),
      updatedAt: nowDate(),
    })
    .where(eq(notionWorkflowPendingEvents.id, args.pending.id));
  args.signal.throwIfAborted();
}

async function markPendingEventProcessed(args: {
  readonly db: Db;
  readonly pendingId: string;
  readonly page: NotionPageResponse;
  readonly parent: NotionPageReference;
  readonly signal: AbortSignal;
}): Promise<void> {
  await args.db
    .update(notionWorkflowPendingEvents)
    .set({
      status: "processed",
      pageTitle: notionTitleFromProperties(args.page.properties),
      pageUrl: args.page.url ?? null,
      parentTitle: args.parent.title,
      parentUrl: args.parent.url,
      processedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(eq(notionWorkflowPendingEvents.id, args.pendingId));
  args.signal.throwIfAborted();
}

function buildNotionWorkflowEventSystemPrompt(args: {
  readonly triggerId: string;
  readonly config: NotionChildPageCreatedEventConfig;
  readonly page: NotionPageResponse;
  readonly parent: NotionPageReference;
  readonly firstEventAt: Date;
  readonly latestEventAt: Date;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  return [
    "# Current context",
    'You are running because a Notion "New Notion child page" workflow event trigger matched a new direct child page under the configured parent page.',
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "The Notion page body is not included in this trigger context. If the workflow needs the page content or child blocks, use the connected Notion tools/API with the page ID below.",
    "",
    "# Notion event",
    JSON.stringify(
      {
        triggerId: args.triggerId,
        event: args.config.event,
        connectorId: args.config.connectorId,
        page: {
          id: args.page.id,
          title: pageTitle,
          url: args.page.url ?? null,
          createdTime: args.page.created_time ?? null,
          lastEditedTime: args.page.last_edited_time ?? null,
        },
        parent: {
          id: args.parent.id,
          title: args.parent.title,
          url: args.parent.url,
        },
        firstEventAt: args.firstEventAt.toISOString(),
        latestEventAt: args.latestEventAt.toISOString(),
      },
      null,
      2,
    ),
  ].join("\n");
}

function buildNotionWorkflowTriggerBrief(args: {
  readonly page: NotionPageResponse;
  readonly parent: NotionPageReference;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const parentTitle = args.parent.title ?? "configured parent";
  return `New Notion child page${pageTitle ? ` "${pageTitle}"` : ""} under ${parentTitle}`;
}

function notionRunFailureMessage(
  result: Exclude<RunWorkflowTriggerResult, { readonly kind: "ok" }>,
): string {
  return result.kind === "conflict"
    ? result.message
    : result.response.body.error.message;
}

async function resolveCurrentParentReference(args: {
  readonly accessToken: string;
  readonly config: NotionChildPageCreatedEventConfig;
  readonly signal: AbortSignal;
}): Promise<NotionPageReference> {
  const parentResult = await retrieveNotionPage({
    accessToken: args.accessToken,
    pageId: args.config.parentPage.id,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (parentResult.kind !== "ok") {
    return args.config.parentPage;
  }
  return notionPageReference(parentResult.value, args.config.parentPage.rawUrl);
}

async function startNotionWorkflowRun(args: {
  readonly row: DueNotionTriggerRow;
  readonly chatThreadId: string;
  readonly pending: NotionPendingRow;
  readonly config: NotionChildPageCreatedEventConfig;
  readonly page: NotionPageResponse;
  readonly parent: NotionPageReference;
  readonly signal: AbortSignal;
  readonly startRun: NotionRunStarter;
}): Promise<RunWorkflowTriggerResult> {
  return await args.startRun(
    {
      due: {
        trigger: args.row.trigger,
        agentId: args.row.agentId,
        workflowName: args.row.workflowName,
        chatThreadId: args.chatThreadId,
      },
      apiStartTime: now(),
      triggerSource: "workflow-event",
      appendSystemPrompt: buildNotionWorkflowEventSystemPrompt({
        triggerId: args.row.trigger.id,
        config: args.config,
        page: args.page,
        parent: args.parent,
        firstEventAt: args.pending.firstEventAt,
        latestEventAt: args.pending.latestEventAt,
      }),
      triggerBrief: buildNotionWorkflowTriggerBrief({
        page: args.page,
        parent: args.parent,
      }),
      callbacks: buildChatOnlyWorkflowTriggerCallbacks(
        args.chatThreadId,
        args.row.agentId,
      ),
      activePreviousRunPolicy: "allow",
      recordLastRunId: false,
      recordLastRunAt: true,
      dispatchFailedCallbacks: dispatchFailedRunCallbacks,
    },
    args.signal,
  );
}

async function processClaimedNotionPendingEvent(args: {
  readonly db: Db;
  readonly pending: NotionPendingRow;
  readonly signal: AbortSignal;
  readonly startRun: NotionRunStarter;
}): Promise<"executed" | "skipped"> {
  const row = await loadDueNotionTriggerRow({
    db: args.db,
    triggerId: args.pending.triggerId,
    signal: args.signal,
  });
  if (!row) {
    return "skipped";
  }
  if (
    row.trigger.kind !== "event" ||
    row.trigger.eventType !== "notion-child-page-created" ||
    !row.trigger.enabled ||
    !row.chatThreadId
  ) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: "Trigger is no longer active",
      signal: args.signal,
    });
    return "skipped";
  }

  const config = notionChildPageCreatedEventConfigSchema.safeParse(
    row.trigger.eventConfig,
  );
  if (
    !config.success ||
    config.data.parentPage.id !== args.pending.parentPageId
  ) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: "Trigger config no longer matches",
      signal: args.signal,
    });
    return "skipped";
  }

  const accessResult = await resolveNotionAccess({
    db: args.db,
    orgId: row.trigger.orgId,
    userId: row.trigger.ownerUserId,
    connectorId: config.data.connectorId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: accessResult.message,
      signal: args.signal,
    });
    return "skipped";
  }

  const childResult = await retrieveNotionPage({
    accessToken: accessResult.access.accessToken,
    pageId: args.pending.pageId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (childResult.kind === "transient_error") {
    await retryPendingEvent({
      db: args.db,
      pending: args.pending,
      message: childResult.message,
      signal: args.signal,
    });
    return "skipped";
  }
  if (childResult.kind !== "ok" || !pageIsUsable(childResult.value)) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: "Notion page is no longer accessible",
      signal: args.signal,
    });
    return "skipped";
  }

  if (notionPageParentPageId(childResult.value) !== config.data.parentPage.id) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: NOTION_CHILD_PAGE_MOVED_SKIP_REASON,
      signal: args.signal,
    });
    return "skipped";
  }

  const parent = await resolveCurrentParentReference({
    accessToken: accessResult.access.accessToken,
    config: config.data,
    signal: args.signal,
  });
  const result = await startNotionWorkflowRun({
    row,
    chatThreadId: row.chatThreadId,
    pending: args.pending,
    config: config.data,
    page: childResult.value,
    parent,
    signal: args.signal,
    startRun: args.startRun,
  });
  args.signal.throwIfAborted();
  if (result.kind !== "ok") {
    await retryPendingEvent({
      db: args.db,
      pending: args.pending,
      message: notionRunFailureMessage(result),
      signal: args.signal,
    });
    return "skipped";
  }

  await markPendingEventProcessed({
    db: args.db,
    pendingId: args.pending.id,
    page: childResult.value,
    parent,
    signal: args.signal,
  });
  return "executed";
}

export const executeDueNotionWorkflowEvents$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ExecuteDueNotionEventsResult> => {
    const db = set(writeDb$);
    const dueEvents = await loadDueNotionPendingEvents({
      db,
      currentTime: nowDate(),
      signal,
    });
    let executed = 0;
    let skipped = 0;
    for (const pending of dueEvents) {
      const claimed = await claimNotionPendingEvent({
        db,
        pending,
        currentTime: nowDate(),
        signal,
      });
      if (!claimed) {
        continue;
      }
      const outcome = await processClaimedNotionPendingEvent({
        db,
        pending: claimed,
        signal,
        startRun: (input, childSignal) => {
          return set(runWorkflowTriggerNow$, input, childSignal);
        },
      });
      if (outcome === "executed") {
        executed += 1;
      } else {
        skipped += 1;
      }
    }
    return { executed, skipped };
  },
);
