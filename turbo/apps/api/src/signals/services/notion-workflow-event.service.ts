import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
  type NotionChildPageCreatedEventConfig,
  type NotionChildPageCreatedEventCreateConfig,
  type NotionDatabaseItemCreatedEventConfig,
  type NotionDatabaseItemCreatedEventCreateConfig,
  type NotionDataSourceReference,
  type NotionPageContentUpdatedEventConfig,
  type NotionPageContentUpdatedEventCreateConfig,
  type NotionPageContentUpdatedScope,
  type NotionPageReference,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { refreshNotionToken } from "@vm0/connectors/auth-providers/connectors/notion/oauth";
import { connectors } from "@vm0/db/schema/connector";
import {
  notionWebhookEvents,
  notionWebhookSecrets,
  notionWorkflowPendingEvents,
  type NotionWorkflowPendingEventFamily,
  type NotionWorkflowPendingEventContext,
} from "@vm0/db/schema/notion-event";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
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
import { recordNotionPageMemorySource } from "./notion-memory-source.service";

const NOTION_ACCESS_TOKEN_SECRET = "NOTION_ACCESS_TOKEN";
const NOTION_REFRESH_TOKEN_SECRET = "NOTION_REFRESH_TOKEN";
const CONNECTOR_SECRET_TYPE = "connector";
export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const NOTION_CHILD_PAGE_SETTLE_MS = 15 * 60 * 1000;
const NOTION_PENDING_RETRY_MS = 5 * 60 * 1000;
const NOTION_PENDING_MAX_ATTEMPTS = 8;
const NOTION_PENDING_BATCH_SIZE = 25;
const NOTION_CHILD_PAGE_MOVED_SKIP_REASON =
  "Notion page is no longer a direct child of the configured parent";
const NOTION_DATABASE_ITEM_MOVED_SKIP_REASON =
  "Notion page is no longer inside the configured data source";
const NOTION_PAGE_CONTENT_UPDATED_MOVED_SKIP_REASON =
  "Notion page is no longer inside the configured content update scope";

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
    id: z.string().optional(),
    type: z.string().optional(),
    data_source_id: z.string().optional(),
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
  z.object({
    type: z.literal("data_source_id"),
    data_source_id: z.string().uuid(),
    database_id: z.string().uuid().optional(),
  }),
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

const notionDataSourceResponseSchema = z
  .object({
    object: z.literal("data_source"),
    id: z.string().uuid(),
    name: z.string().nullable().optional(),
    url: z.string().url().optional(),
    parent: z
      .object({
        type: z.literal("database_id"),
        database_id: z.string().uuid(),
      })
      .passthrough(),
  })
  .passthrough();

const notionDatabaseResponseSchema = z
  .object({
    object: z.literal("database"),
    id: z.string().uuid(),
    url: z.string().url().optional(),
    title: z
      .array(
        z
          .object({
            plain_text: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    data_sources: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

type NotionWebhookEvent = z.infer<typeof notionWebhookEventSchema>;
type NotionPageResponse = z.infer<typeof notionPageResponseSchema>;
type NotionDataSourceResponse = z.infer<typeof notionDataSourceResponseSchema>;
type NotionDatabaseResponse = z.infer<typeof notionDatabaseResponseSchema>;
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
type NotionTriggerEventType =
  | "notion-child-page-created"
  | "notion-database-item-created"
  | "notion-page-content-updated";
type NotionRunStarter = (
  args: RunWorkflowTriggerNowArgs,
  signal: AbortSignal,
) => Promise<RunWorkflowTriggerResult>;
interface ProcessClaimedNotionPendingEventArgs {
  readonly db: Db;
  readonly row: DueNotionTriggerRow;
  readonly pending: NotionPendingRow;
  readonly signal: AbortSignal;
  readonly startRun: NotionRunStarter;
}

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

function parseStandardNotionUrlId(value: string): string | null {
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

function parseStandardNotionPageUrl(value: string): string | null {
  return parseStandardNotionUrlId(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function notionTitleFromProperties(
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

function notionDatabaseTitle(database: NotionDatabaseResponse): string | null {
  const title = database.title
    .map((item) => {
      return item.plain_text ?? "";
    })
    .join("")
    .trim();
  return title.length > 0 ? title : null;
}

function notionDataSourceReference(args: {
  readonly dataSource: NotionDataSourceResponse;
  readonly title: string | null;
  readonly rawUrl?: string;
}): NotionDataSourceReference {
  return {
    id: args.dataSource.id,
    url:
      args.dataSource.url ??
      args.rawUrl ??
      `https://www.notion.so/${args.dataSource.id}`,
    title: args.title,
    ...(args.rawUrl ? { rawUrl: args.rawUrl } : {}),
  };
}

function notionPageParentPageId(page: NotionPageResponse): string | null {
  return page.parent.type === "page_id" ? page.parent.page_id : null;
}

function notionPageParentDataSourceId(page: NotionPageResponse): string | null {
  return page.parent.type === "data_source_id"
    ? page.parent.data_source_id
    : null;
}

export function pageIsUsable(page: NotionPageResponse): boolean {
  return page.archived !== true && page.in_trash !== true;
}

function notionEventContext(
  event: NotionWebhookEvent,
): NotionWorkflowPendingEventContext {
  return {
    workspaceId: event.workspace_id,
    workspaceName: event.workspace_name ?? null,
    authors: event.authors.map((author) => {
      return {
        id: author.id,
        type: author.type,
      };
    }),
    attemptNumber: event.attempt_number ?? null,
  };
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

export async function resolveNotionAccess(args: {
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

async function retrieveNotionDataSource(args: {
  readonly accessToken: string;
  readonly dataSourceId: string;
  readonly signal: AbortSignal;
}): Promise<NotionFetchResult<NotionDataSourceResponse>> {
  return await notionFetchJson(
    notionDataSourceResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/data_sources/${args.dataSourceId}`,
    args.signal,
  );
}

async function retrieveNotionDatabase(args: {
  readonly accessToken: string;
  readonly databaseId: string;
  readonly signal: AbortSignal;
}): Promise<NotionFetchResult<NotionDatabaseResponse>> {
  return await notionFetchJson(
    notionDatabaseResponseSchema,
    args.accessToken,
    `${NOTION_API_BASE}/databases/${args.databaseId}`,
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

export async function prepareNotionDatabaseItemEventConfigForPersist(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly eventConfig: NotionDatabaseItemCreatedEventCreateConfig;
    readonly signal: AbortSignal;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: NotionDatabaseItemCreatedEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const notionId = parseStandardNotionUrlId(args.eventConfig.databaseUrl);
  if (!notionId) {
    return {
      kind: "bad-request",
      message: "Enter a standard notion.so database URL",
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

  const databaseResult = await retrieveNotionDatabase({
    accessToken: accessResult.access.accessToken,
    databaseId: notionId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (databaseResult.kind === "ok") {
    const [firstDataSource] = databaseResult.value.data_sources;
    if (!firstDataSource) {
      return {
        kind: "bad-request",
        message: "Notion database does not expose a data source",
      };
    }
    const dataSourceResult = await retrieveNotionDataSource({
      accessToken: accessResult.access.accessToken,
      dataSourceId: firstDataSource.id,
      signal: args.signal,
    });
    args.signal.throwIfAborted();
    if (
      dataSourceResult.kind === "not_found" ||
      dataSourceResult.kind === "unauthorized"
    ) {
      return {
        kind: "bad-request",
        message: "Zero cannot access this Notion database",
      };
    }
    if (dataSourceResult.kind !== "ok") {
      return {
        kind: "bad-request",
        message: "Failed to validate Notion database URL",
      };
    }
    return {
      kind: "ok",
      eventConfig: {
        provider: "notion",
        event: "database_item_created",
        connectorId: accessResult.access.connectorId,
        dataSource: notionDataSourceReference({
          dataSource: dataSourceResult.value,
          title:
            firstDataSource.name ??
            dataSourceResult.value.name ??
            notionDatabaseTitle(databaseResult.value),
          rawUrl: args.eventConfig.databaseUrl,
        }),
      },
    };
  }
  if (databaseResult.kind === "transient_error") {
    return {
      kind: "bad-request",
      message: "Failed to validate Notion database URL",
    };
  }

  const dataSourceResult = await retrieveNotionDataSource({
    accessToken: accessResult.access.accessToken,
    dataSourceId: notionId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (
    dataSourceResult.kind === "not_found" ||
    dataSourceResult.kind === "unauthorized"
  ) {
    return {
      kind: "bad-request",
      message: "Zero cannot access this Notion database",
    };
  }
  if (dataSourceResult.kind !== "ok") {
    return {
      kind: "bad-request",
      message: "Failed to validate Notion database URL",
    };
  }

  return {
    kind: "ok",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      connectorId: accessResult.access.connectorId,
      dataSource: notionDataSourceReference({
        dataSource: dataSourceResult.value,
        title: dataSourceResult.value.name ?? null,
        rawUrl: args.eventConfig.databaseUrl,
      }),
    },
  };
}

export async function prepareNotionPageContentUpdatedEventConfigForPersist(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly eventConfig: NotionPageContentUpdatedEventCreateConfig;
    readonly signal: AbortSignal;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: NotionPageContentUpdatedEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  if (args.eventConfig.pageUrl !== undefined) {
    const pageResult = await prepareNotionChildPageEventConfigForPersist(db, {
      orgId: args.orgId,
      userId: args.userId,
      eventConfig: {
        provider: "notion",
        event: "child_page_created",
        parentPageUrl: args.eventConfig.pageUrl,
      },
      signal: args.signal,
    });
    args.signal.throwIfAborted();
    if (pageResult.kind !== "ok") {
      return pageResult;
    }
    return {
      kind: "ok",
      eventConfig: {
        provider: "notion",
        event: "page_content_updated",
        connectorId: pageResult.eventConfig.connectorId,
        scope: {
          type: "page",
          page: pageResult.eventConfig.parentPage,
        },
      },
    };
  }

  if (args.eventConfig.databaseUrl === undefined) {
    return {
      kind: "bad-request",
      message: "Provide exactly one of pageUrl or databaseUrl",
    };
  }
  const dataSourceResult = await prepareNotionDatabaseItemEventConfigForPersist(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      eventConfig: {
        provider: "notion",
        event: "database_item_created",
        databaseUrl: args.eventConfig.databaseUrl,
      },
      signal: args.signal,
    },
  );
  args.signal.throwIfAborted();
  if (dataSourceResult.kind !== "ok") {
    return dataSourceResult;
  }
  return {
    kind: "ok",
    eventConfig: {
      provider: "notion",
      event: "page_content_updated",
      connectorId: dataSourceResult.eventConfig.connectorId,
      scope: {
        type: "data_source",
        dataSource: dataSourceResult.eventConfig.dataSource,
      },
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
  if (!parent || parent.data_source_id) {
    return null;
  }
  if (parent.type && parent.type !== "page" && parent.type !== "page_id") {
    return null;
  }
  return parent.id ? normalizeNotionUuid(parent.id) : null;
}

function eventDataSourceParentId(event: NotionWebhookEvent): string | null {
  const parent = event.data.parent;
  if (!parent) {
    return null;
  }
  if (parent.data_source_id) {
    return normalizeNotionUuid(parent.data_source_id);
  }
  if (parent.type !== "data_source" && parent.type !== "data_source_id") {
    return null;
  }
  return parent.id ? normalizeNotionUuid(parent.id) : null;
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

async function loadNotionDatabaseItemTriggers(args: {
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
        eq(zeroWorkflowTriggers.eventType, "notion-database-item-created"),
      ),
    );
  args.signal.throwIfAborted();
  return rows;
}

async function loadNotionPageContentUpdatedTriggers(args: {
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
        eq(zeroWorkflowTriggers.eventType, "notion-page-content-updated"),
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
        scopeType: "page",
        scopeId: args.parentPageId,
        eventFamily: "new_child_page",
        status: "pending",
        firstNotionEventId: args.event.id,
        latestNotionEventId: args.event.id,
        firstEventAt: eventTimestamp(args.event),
        latestEventAt: eventTimestamp(args.event),
        latestEventContext: notionEventContext(args.event),
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

async function enqueueNotionDatabaseItemEvents(args: {
  readonly db: Db;
  readonly event: NotionWebhookEvent;
  readonly pageId: string;
  readonly dataSourceId: string;
  readonly signal: AbortSignal;
}): Promise<number> {
  const triggers = await loadNotionDatabaseItemTriggers(args);
  let pending = 0;
  for (const trigger of triggers) {
    const config = notionDatabaseItemCreatedEventConfigSchema.safeParse(
      trigger.eventConfig,
    );
    if (!config.success || config.data.dataSource.id !== args.dataSourceId) {
      continue;
    }
    const [inserted] = await args.db
      .insert(notionWorkflowPendingEvents)
      .values({
        triggerId: trigger.id,
        pageId: args.pageId,
        scopeType: "data_source",
        scopeId: args.dataSourceId,
        eventFamily: "new_database_item",
        status: "pending",
        firstNotionEventId: args.event.id,
        latestNotionEventId: args.event.id,
        firstEventAt: eventTimestamp(args.event),
        latestEventAt: eventTimestamp(args.event),
        latestEventContext: notionEventContext(args.event),
        runAfter: runAfterForEvent(args.event),
        parentTitle: config.data.dataSource.title,
        parentUrl: config.data.dataSource.url,
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

function pageContentUpdatedScopeType(
  scope: NotionPageContentUpdatedScope,
): "page" | "data_source" {
  return scope.type === "page" ? "page" : "data_source";
}

function pageContentUpdatedScopeId(
  scope: NotionPageContentUpdatedScope,
): string {
  return scope.type === "page" ? scope.page.id : scope.dataSource.id;
}

function pageContentUpdatedScopeParent(scope: NotionPageContentUpdatedScope): {
  readonly title: string | null;
  readonly url: string;
} {
  return scope.type === "page"
    ? { title: scope.page.title, url: scope.page.url }
    : { title: scope.dataSource.title, url: scope.dataSource.url };
}

async function dataSourceIdForContentUpdatedEvent(args: {
  readonly db: Db;
  readonly trigger: TriggerRow;
  readonly config: NotionPageContentUpdatedEventConfig;
  readonly event: NotionWebhookEvent;
  readonly pageId: string;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const eventDataSourceId = eventDataSourceParentId(args.event);
  if (eventDataSourceId) {
    return eventDataSourceId;
  }

  const accessResult = await resolveNotionAccess({
    db: args.db,
    orgId: args.trigger.orgId,
    userId: args.trigger.ownerUserId,
    connectorId: args.config.connectorId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return null;
  }
  const pageResult = await retrieveNotionPage({
    accessToken: accessResult.access.accessToken,
    pageId: args.pageId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  return pageResult.kind === "ok"
    ? notionPageParentDataSourceId(pageResult.value)
    : null;
}

async function contentUpdatedTriggerMatchesEvent(args: {
  readonly db: Db;
  readonly trigger: TriggerRow;
  readonly config: NotionPageContentUpdatedEventConfig;
  readonly event: NotionWebhookEvent;
  readonly pageId: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  if (args.config.scope.type === "page") {
    return args.config.scope.page.id === args.pageId;
  }
  const dataSourceId = await dataSourceIdForContentUpdatedEvent(args);
  return dataSourceId === args.config.scope.dataSource.id;
}

async function enqueueOrRefreshNotionPageContentUpdatedEvents(args: {
  readonly db: Db;
  readonly event: NotionWebhookEvent;
  readonly pageId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly pending: number; readonly refreshed: number }> {
  const triggers = await loadNotionPageContentUpdatedTriggers(args);
  let pending = 0;
  let refreshed = 0;
  for (const trigger of triggers) {
    const config = notionPageContentUpdatedEventConfigSchema.safeParse(
      trigger.eventConfig,
    );
    if (!config.success) {
      continue;
    }
    if (
      !(await contentUpdatedTriggerMatchesEvent({
        db: args.db,
        trigger,
        config: config.data,
        event: args.event,
        pageId: args.pageId,
        signal: args.signal,
      }))
    ) {
      continue;
    }

    const currentTime = nowDate();
    const [updated] = await args.db
      .update(notionWorkflowPendingEvents)
      .set({
        latestNotionEventId: args.event.id,
        latestEventAt: eventTimestamp(args.event),
        latestEventContext: notionEventContext(args.event),
        runAfter: runAfterForEvent(args.event),
        lastError: null,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(notionWorkflowPendingEvents.triggerId, trigger.id),
          eq(notionWorkflowPendingEvents.pageId, args.pageId),
          eq(notionWorkflowPendingEvents.eventFamily, "page_content_updated"),
          eq(notionWorkflowPendingEvents.status, "pending"),
        ),
      )
      .returning({ id: notionWorkflowPendingEvents.id });
    args.signal.throwIfAborted();
    if (updated) {
      refreshed += 1;
      continue;
    }

    const parent = pageContentUpdatedScopeParent(config.data.scope);
    const [inserted] = await args.db
      .insert(notionWorkflowPendingEvents)
      .values({
        triggerId: trigger.id,
        pageId: args.pageId,
        scopeType: pageContentUpdatedScopeType(config.data.scope),
        scopeId: pageContentUpdatedScopeId(config.data.scope),
        eventFamily: "page_content_updated",
        status: "pending",
        firstNotionEventId: args.event.id,
        latestNotionEventId: args.event.id,
        firstEventAt: eventTimestamp(args.event),
        latestEventAt: eventTimestamp(args.event),
        latestEventContext: notionEventContext(args.event),
        runAfter: runAfterForEvent(args.event),
        parentTitle: parent.title,
        parentUrl: parent.url,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .onConflictDoNothing()
      .returning({ id: notionWorkflowPendingEvents.id });
    args.signal.throwIfAborted();
    if (inserted) {
      pending += 1;
    }
  }
  return { pending, refreshed };
}

async function refreshPendingNotionCreatedPageEvents(args: {
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
      latestEventContext: notionEventContext(args.event),
      runAfter: runAfterForEvent(args.event),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(notionWorkflowPendingEvents.pageId, args.pageId),
        eq(notionWorkflowPendingEvents.status, "pending"),
        inArray(notionWorkflowPendingEvents.eventFamily, [
          "new_child_page",
          "new_database_item",
        ]),
      ),
    )
    .returning({ id: notionWorkflowPendingEvents.id });
  args.signal.throwIfAborted();
  return refreshed.length;
}

async function hasActiveNotionCreatedPageEvent(args: {
  readonly db: Db;
  readonly pageId: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const [active] = await args.db
    .select({ id: notionWorkflowPendingEvents.id })
    .from(notionWorkflowPendingEvents)
    .where(
      and(
        eq(notionWorkflowPendingEvents.pageId, args.pageId),
        inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
        inArray(notionWorkflowPendingEvents.eventFamily, [
          "new_child_page",
          "new_database_item",
        ]),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return active !== undefined;
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
    if (parentPageId) {
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
    const dataSourceId = eventDataSourceParentId(args.event);
    if (!dataSourceId) {
      return { pending: 0, refreshed: 0, duplicates: 0 };
    }
    return {
      pending: await enqueueNotionDatabaseItemEvents({
        db: args.db,
        event: args.event,
        pageId,
        dataSourceId,
        signal: args.signal,
      }),
      refreshed: 0,
      duplicates: 0,
    };
  }

  const refreshedCreated = await refreshPendingNotionCreatedPageEvents({
    db: args.db,
    event: args.event,
    pageId,
    signal: args.signal,
  });
  if (args.event.type !== "page.content_updated") {
    return { pending: 0, refreshed: refreshedCreated, duplicates: 0 };
  }
  if (
    refreshedCreated > 0 ||
    (await hasActiveNotionCreatedPageEvent({
      db: args.db,
      pageId,
      signal: args.signal,
    }))
  ) {
    return { pending: 0, refreshed: refreshedCreated, duplicates: 0 };
  }
  const contentUpdated = await enqueueOrRefreshNotionPageContentUpdatedEvents({
    db: args.db,
    event: args.event,
    pageId,
    signal: args.signal,
  });
  return {
    pending: contentUpdated.pending,
    refreshed: refreshedCreated + contentUpdated.refreshed,
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
  readonly parent: {
    readonly title: string | null;
    readonly url: string;
  };
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

function buildNotionChildPageWorkflowEventSystemPrompt(args: {
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

function buildNotionDatabaseItemWorkflowEventSystemPrompt(args: {
  readonly triggerId: string;
  readonly config: NotionDatabaseItemCreatedEventConfig;
  readonly page: NotionPageResponse;
  readonly dataSource: NotionDataSourceReference;
  readonly firstEventAt: Date;
  readonly latestEventAt: Date;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  return [
    "# Current context",
    'You are running because a Notion "New Notion database item" workflow event trigger matched a new page inside the configured Notion database.',
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
          properties: args.page.properties ?? {},
        },
        dataSource: {
          id: args.dataSource.id,
          title: args.dataSource.title,
          url: args.dataSource.url,
        },
        firstEventAt: args.firstEventAt.toISOString(),
        latestEventAt: args.latestEventAt.toISOString(),
      },
      null,
      2,
    ),
  ].join("\n");
}

function buildNotionPageContentUpdatedWorkflowEventSystemPrompt(args: {
  readonly triggerId: string;
  readonly config: NotionPageContentUpdatedEventConfig;
  readonly page: NotionPageResponse;
  readonly scope: NotionPageContentUpdatedScope;
  readonly firstEventAt: Date;
  readonly latestEventAt: Date;
  readonly latestEventContext: NotionWorkflowPendingEventContext | null;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const scope =
    args.scope.type === "page"
      ? {
          type: "page" as const,
          page: {
            id: args.scope.page.id,
            title: args.scope.page.title,
            url: args.scope.page.url,
          },
        }
      : {
          type: "database" as const,
          dataSource: {
            id: args.scope.dataSource.id,
            title: args.scope.dataSource.title,
            url: args.scope.dataSource.url,
          },
        };
  return [
    "# Current context",
    'You are running because a Notion "Page content updated" workflow event trigger matched a content update on a configured Notion page or database item.',
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
          properties: args.page.properties ?? {},
        },
        scope,
        firstEventAt: args.firstEventAt.toISOString(),
        latestEventAt: args.latestEventAt.toISOString(),
        latestEventContext: args.latestEventContext,
      },
      null,
      2,
    ),
  ].join("\n");
}

function buildNotionChildPageWorkflowTriggerBrief(args: {
  readonly page: NotionPageResponse;
  readonly parent: NotionPageReference;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const parentTitle = args.parent.title ?? "configured parent";
  return `New Notion child page${pageTitle ? ` "${pageTitle}"` : ""} under ${parentTitle}`;
}

function buildNotionDatabaseItemWorkflowTriggerBrief(args: {
  readonly page: NotionPageResponse;
  readonly dataSource: NotionDataSourceReference;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const dataSourceTitle = args.dataSource.title ?? "configured database";
  return `New Notion database item${pageTitle ? ` "${pageTitle}"` : ""} in ${dataSourceTitle}`;
}

function buildNotionPageContentUpdatedWorkflowTriggerBrief(args: {
  readonly page: NotionPageResponse;
  readonly scope: NotionPageContentUpdatedScope;
}): string {
  const pageTitle = notionTitleFromProperties(args.page.properties);
  const scopeTitle =
    args.scope.type === "page"
      ? (args.scope.page.title ?? "configured page")
      : (args.scope.dataSource.title ?? "configured database");
  return `Notion page content updated${pageTitle ? ` "${pageTitle}"` : ""} in ${scopeTitle}`;
}

function notionRunFailureMessage(
  result: Exclude<
    RunWorkflowTriggerResult,
    { readonly kind: "ok" } | { readonly kind: "enqueued" }
  >,
): string {
  return result.kind === "conflict"
    ? result.message
    : result.response.body.error.message;
}

function notionMemoryEventType(
  eventFamily: NotionWorkflowPendingEventFamily,
): "page.created" | "page.content_updated" | "page.properties_updated" {
  return eventFamily === "page_content_updated"
    ? "page.content_updated"
    : "page.created";
}

async function recordNotionPendingPageMemorySource(args: {
  readonly db: Db;
  readonly row: DueNotionTriggerRow;
  readonly pending: NotionPendingRow;
  readonly connectorId: string;
  readonly page: NotionPageResponse;
  readonly parent: {
    readonly title: string | null;
    readonly url: string | null;
  };
}): Promise<boolean> {
  const context = args.pending.latestEventContext;
  return await recordNotionPageMemorySource({
    db: args.db,
    orgId: args.row.trigger.orgId,
    userId: args.row.trigger.ownerUserId,
    connectorId: args.connectorId,
    page: {
      id: args.page.id,
      title: notionTitleFromProperties(args.page.properties),
      url: args.page.url ?? null,
      createdTime: args.page.created_time ?? null,
      lastEditedTime: args.page.last_edited_time ?? null,
    },
    parent: args.parent,
    workspaceId: context?.workspaceId ?? null,
    workspaceName: context?.workspaceName ?? null,
    eventId: args.pending.latestNotionEventId,
    eventFamily: args.pending.eventFamily,
    eventType: notionMemoryEventType(args.pending.eventFamily),
    scopeType: args.pending.scopeType,
    scopeId: args.pending.scopeId,
    authorIds:
      context?.authors.map((author) => {
        return author.id;
      }) ?? [],
    occurredAt: args.pending.latestEventAt,
    reason: `notion_${args.pending.eventFamily}`,
  });
}

async function recordNotionMemorySourceForPending(
  args: ProcessClaimedNotionPendingEventArgs,
  connectorId: string,
  page: NotionPageResponse,
  parent: {
    readonly title: string | null;
    readonly url: string | null;
  },
): Promise<void> {
  await recordNotionPendingPageMemorySource({
    db: args.db,
    row: args.row,
    pending: args.pending,
    connectorId,
    page,
    parent,
  });
  args.signal.throwIfAborted();
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

async function resolveCurrentDataSourceReference(args: {
  readonly accessToken: string;
  readonly config: { readonly dataSource: NotionDataSourceReference };
  readonly signal: AbortSignal;
}): Promise<NotionDataSourceReference> {
  const dataSourceResult = await retrieveNotionDataSource({
    accessToken: args.accessToken,
    dataSourceId: args.config.dataSource.id,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (dataSourceResult.kind !== "ok") {
    return args.config.dataSource;
  }
  return notionDataSourceReference({
    dataSource: dataSourceResult.value,
    title: dataSourceResult.value.name ?? args.config.dataSource.title,
    rawUrl: args.config.dataSource.rawUrl,
  });
}

async function resolveCurrentPageContentUpdatedScope(args: {
  readonly accessToken: string;
  readonly page: NotionPageResponse;
  readonly scope: NotionPageContentUpdatedScope;
  readonly signal: AbortSignal;
}): Promise<NotionPageContentUpdatedScope> {
  if (args.scope.type === "page") {
    return {
      type: "page",
      page: notionPageReference(args.page, args.scope.page.rawUrl),
    };
  }
  return {
    type: "data_source",
    dataSource: await resolveCurrentDataSourceReference({
      accessToken: args.accessToken,
      config: { dataSource: args.scope.dataSource },
      signal: args.signal,
    }),
  };
}

function pageContentUpdatedScopeStillMatches(args: {
  readonly page: NotionPageResponse;
  readonly scope: NotionPageContentUpdatedScope;
}): boolean {
  return args.scope.type === "page"
    ? args.page.id === args.scope.page.id
    : notionPageParentDataSourceId(args.page) === args.scope.dataSource.id;
}

async function startNotionWorkflowRun(args: {
  readonly row: DueNotionTriggerRow;
  readonly chatThreadId: string;
  readonly appendSystemPrompt: string;
  readonly triggerBrief: string;
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
      appendSystemPrompt: args.appendSystemPrompt,
      triggerBrief: args.triggerBrief,
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

function notionTriggerIsActive(
  row: DueNotionTriggerRow,
  eventType: NotionTriggerEventType,
): boolean {
  return (
    row.trigger.kind === "event" &&
    row.trigger.eventType === eventType &&
    row.trigger.enabled
  );
}

async function processClaimedNotionChildPagePendingEvent(
  args: ProcessClaimedNotionPendingEventArgs,
): Promise<"executed" | "skipped"> {
  if (
    !notionTriggerIsActive(args.row, "notion-child-page-created") ||
    !args.row.chatThreadId
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
    args.row.trigger.eventConfig,
  );
  if (
    !config.success ||
    args.pending.scopeType !== "page" ||
    config.data.parentPage.id !== args.pending.scopeId
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
    orgId: args.row.trigger.orgId,
    userId: args.row.trigger.ownerUserId,
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

  const childPage = await retrieveUsablePendingNotionPage({
    db: args.db,
    pending: args.pending,
    accessToken: accessResult.access.accessToken,
    signal: args.signal,
  });
  if (!childPage) {
    return "skipped";
  }

  if (notionPageParentPageId(childPage) !== config.data.parentPage.id) {
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
  await recordNotionMemorySourceForPending(
    args,
    config.data.connectorId,
    childPage,
    parent,
  );

  const result = await startNotionWorkflowRun({
    row: args.row,
    chatThreadId: args.row.chatThreadId,
    appendSystemPrompt: buildNotionChildPageWorkflowEventSystemPrompt({
      triggerId: args.row.trigger.id,
      config: config.data,
      page: childPage,
      parent,
      firstEventAt: args.pending.firstEventAt,
      latestEventAt: args.pending.latestEventAt,
    }),
    triggerBrief: buildNotionChildPageWorkflowTriggerBrief({
      page: childPage,
      parent,
    }),
    signal: args.signal,
    startRun: args.startRun,
  });
  args.signal.throwIfAborted();
  if (result.kind !== "ok" && result.kind !== "enqueued") {
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
    page: childPage,
    parent,
    signal: args.signal,
  });
  return "executed";
}

async function processClaimedNotionDatabaseItemPendingEvent(
  args: ProcessClaimedNotionPendingEventArgs,
): Promise<"executed" | "skipped"> {
  if (
    !notionTriggerIsActive(args.row, "notion-database-item-created") ||
    !args.row.chatThreadId
  ) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: "Trigger is no longer active",
      signal: args.signal,
    });
    return "skipped";
  }

  const config = notionDatabaseItemCreatedEventConfigSchema.safeParse(
    args.row.trigger.eventConfig,
  );
  if (
    !config.success ||
    args.pending.scopeType !== "data_source" ||
    config.data.dataSource.id !== args.pending.scopeId
  ) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: "Trigger config no longer matches",
      signal: args.signal,
    });
    return "skipped";
  }
  const dataSourceId = config.data.dataSource.id;

  const accessResult = await resolveNotionAccess({
    db: args.db,
    orgId: args.row.trigger.orgId,
    userId: args.row.trigger.ownerUserId,
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

  const page = await retrieveUsablePendingNotionPage({
    db: args.db,
    pending: args.pending,
    accessToken: accessResult.access.accessToken,
    signal: args.signal,
  });
  if (!page) {
    return "skipped";
  }

  if (notionPageParentDataSourceId(page) !== dataSourceId) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: NOTION_DATABASE_ITEM_MOVED_SKIP_REASON,
      signal: args.signal,
    });
    return "skipped";
  }

  const dataSource = await resolveCurrentDataSourceReference({
    accessToken: accessResult.access.accessToken,
    config: config.data,
    signal: args.signal,
  });
  await recordNotionMemorySourceForPending(
    args,
    config.data.connectorId,
    page,
    dataSource,
  );

  const result = await startNotionWorkflowRun({
    row: args.row,
    chatThreadId: args.row.chatThreadId,
    appendSystemPrompt: buildNotionDatabaseItemWorkflowEventSystemPrompt({
      triggerId: args.row.trigger.id,
      config: config.data,
      page,
      dataSource,
      firstEventAt: args.pending.firstEventAt,
      latestEventAt: args.pending.latestEventAt,
    }),
    triggerBrief: buildNotionDatabaseItemWorkflowTriggerBrief({
      page,
      dataSource,
    }),
    signal: args.signal,
    startRun: args.startRun,
  });
  args.signal.throwIfAborted();
  if (result.kind !== "ok" && result.kind !== "enqueued") {
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
    page,
    parent: dataSource,
    signal: args.signal,
  });
  return "executed";
}

async function retrieveUsablePendingNotionPage(args: {
  readonly db: Db;
  readonly pending: NotionPendingRow;
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<NotionPageResponse | null> {
  const pageResult = await retrieveNotionPage({
    accessToken: args.accessToken,
    pageId: args.pending.pageId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (pageResult.kind === "transient_error") {
    await retryPendingEvent({
      db: args.db,
      pending: args.pending,
      message: pageResult.message,
      signal: args.signal,
    });
    return null;
  }
  if (pageResult.kind !== "ok" || !pageIsUsable(pageResult.value)) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: "Notion page is no longer accessible",
      signal: args.signal,
    });
    return null;
  }
  return pageResult.value;
}

async function processClaimedNotionPageContentUpdatedPendingEvent(
  args: ProcessClaimedNotionPendingEventArgs,
): Promise<"executed" | "skipped"> {
  if (
    !notionTriggerIsActive(args.row, "notion-page-content-updated") ||
    !args.row.chatThreadId
  ) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: "Trigger is no longer active",
      signal: args.signal,
    });
    return "skipped";
  }

  const config = notionPageContentUpdatedEventConfigSchema.safeParse(
    args.row.trigger.eventConfig,
  );
  if (
    !config.success ||
    args.pending.scopeType !== pageContentUpdatedScopeType(config.data.scope) ||
    args.pending.scopeId !== pageContentUpdatedScopeId(config.data.scope)
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
    orgId: args.row.trigger.orgId,
    userId: args.row.trigger.ownerUserId,
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

  const page = await retrieveUsablePendingNotionPage({
    db: args.db,
    pending: args.pending,
    accessToken: accessResult.access.accessToken,
    signal: args.signal,
  });
  if (!page) {
    return "skipped";
  }

  if (
    !pageContentUpdatedScopeStillMatches({
      page,
      scope: config.data.scope,
    })
  ) {
    await skipPendingEvent({
      db: args.db,
      pendingId: args.pending.id,
      reason: NOTION_PAGE_CONTENT_UPDATED_MOVED_SKIP_REASON,
      signal: args.signal,
    });
    return "skipped";
  }

  const scope = await resolveCurrentPageContentUpdatedScope({
    accessToken: accessResult.access.accessToken,
    page,
    scope: config.data.scope,
    signal: args.signal,
  });
  await recordNotionMemorySourceForPending(
    args,
    config.data.connectorId,
    page,
    pageContentUpdatedScopeParent(scope),
  );

  const result = await startNotionWorkflowRun({
    row: args.row,
    chatThreadId: args.row.chatThreadId,
    appendSystemPrompt: buildNotionPageContentUpdatedWorkflowEventSystemPrompt({
      triggerId: args.row.trigger.id,
      config: config.data,
      page,
      scope,
      firstEventAt: args.pending.firstEventAt,
      latestEventAt: args.pending.latestEventAt,
      latestEventContext: args.pending.latestEventContext ?? null,
    }),
    triggerBrief: buildNotionPageContentUpdatedWorkflowTriggerBrief({
      page,
      scope,
    }),
    signal: args.signal,
    startRun: args.startRun,
  });
  args.signal.throwIfAborted();
  if (result.kind !== "ok" && result.kind !== "enqueued") {
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
    page,
    parent: pageContentUpdatedScopeParent(scope),
    signal: args.signal,
  });
  return "executed";
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
  if (args.pending.eventFamily === "new_database_item") {
    return await processClaimedNotionDatabaseItemPendingEvent({
      ...args,
      row,
    });
  }
  if (args.pending.eventFamily === "page_content_updated") {
    return await processClaimedNotionPageContentUpdatedPendingEvent({
      ...args,
      row,
    });
  }
  return await processClaimedNotionChildPagePendingEvent({
    ...args,
    row,
  });
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
