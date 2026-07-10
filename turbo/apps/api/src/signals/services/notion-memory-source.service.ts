import type {
  NotionWorkflowPendingEventFamily,
  NotionWorkflowPendingEventScopeType,
} from "@vm0/db/schema/notion-event";

import type { Db } from "../external/db";
import {
  memoryContentHash,
  recordMemorySource,
} from "./memory-substrate.service";
import { enqueueMemorySourceRelationshipExtractionJob } from "./relationship-memory-gmail-queue.service";
import {
  normalizedConnectorMemoryDocumentAdapter,
  recordConnectorMemoryDocument,
} from "./zero-memory-connector-adapter.service";

interface NotionPageMemorySourcePage {
  readonly id: string;
  readonly title: string | null;
  readonly url: string | null;
  readonly createdTime: string | null;
  readonly lastEditedTime: string | null;
}

interface NotionPageMemorySourceParent {
  readonly title: string | null;
  readonly url: string | null;
}

function notionPageExternalId(args: {
  readonly connectorId: string;
  readonly pageId: string;
  readonly eventFamily: NotionWorkflowPendingEventFamily;
}): string {
  return [args.connectorId, args.pageId, args.eventFamily].join(":");
}

function notionBackfillPageExternalId(args: {
  readonly connectorId: string;
  readonly pageId: string;
}): string {
  return [args.connectorId, args.pageId, "backfill"].join(":");
}

function parsedDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function notionContextSpace(args: {
  readonly connectorId: string;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
}) {
  const key = `notion:${args.workspaceId ?? args.connectorId}`;
  return {
    type: "project" as const,
    key,
    displayName: args.workspaceName ?? "Notion workspace",
    metadata: {
      provider: "notion",
      externalId: args.workspaceId ?? args.connectorId,
      displayName: args.workspaceName ?? "Notion workspace",
      reason: "Notion workspace memory context",
    },
  };
}

function notionPageDocumentContent(args: {
  readonly page: NotionPageMemorySourcePage;
  readonly parent?: NotionPageMemorySourceParent;
  readonly workspaceName: string | null;
  readonly eventFamily?: NotionWorkflowPendingEventFamily;
  readonly eventType?: string;
}): string {
  return [
    `# ${args.page.title ?? "Untitled Notion page"}`,
    "",
    args.workspaceName ? `Workspace: ${args.workspaceName}` : null,
    args.parent?.title ? `Parent: ${args.parent.title}` : null,
    args.page.url ? `URL: ${args.page.url}` : null,
    args.eventFamily ? `Event family: ${args.eventFamily}` : null,
    args.eventType ? `Event type: ${args.eventType}` : null,
    args.page.lastEditedTime
      ? `Last edited: ${args.page.lastEditedTime}`
      : null,
  ]
    .filter((line): line is string => {
      return line !== null;
    })
    .join("\n");
}

export async function recordNotionPageMemorySource(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly page: NotionPageMemorySourcePage;
  readonly parent: NotionPageMemorySourceParent;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly eventId: string;
  readonly eventFamily: NotionWorkflowPendingEventFamily;
  readonly eventType:
    | "page.created"
    | "page.content_updated"
    | "page.properties_updated";
  readonly scopeType: NotionWorkflowPendingEventScopeType;
  readonly scopeId: string;
  readonly authorIds: readonly string[];
  readonly occurredAt: Date;
  readonly reason: string;
}): Promise<boolean> {
  const externalId = notionPageExternalId({
    connectorId: args.connectorId,
    pageId: args.page.id,
    eventFamily: args.eventFamily,
  });
  const contentHash = memoryContentHash(
    [
      args.page.title ?? "",
      args.page.url ?? "",
      args.parent.title ?? "",
      args.eventFamily,
      args.eventType,
    ].join("\n"),
  );

  const didRecord = await recordMemorySource(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "notion",
    sourceType: "notion_page_event",
    externalId,
    connectorId: args.connectorId,
    occurredAt:
      parsedDate(args.page.lastEditedTime) ??
      parsedDate(args.page.createdTime) ??
      args.occurredAt,
    title: args.page.title,
    contentHash,
    metadata: {
      notionWorkspaceId: args.workspaceId ?? undefined,
      notionWorkspaceName: args.workspaceName,
      notionPageId: args.page.id,
      notionPageUrl: args.page.url,
      notionEventId: args.eventId,
      notionEventFamily: args.eventFamily,
      notionEventType: args.eventType,
      notionScopeType: args.scopeType,
      notionScopeId: args.scopeId,
      notionParentTitle: args.parent.title,
      notionParentUrl: args.parent.url,
      notionAuthorIds: [...args.authorIds],
      direction: "unknown",
      reason: args.reason,
    },
  });
  if (!didRecord) {
    return false;
  }

  const occurredAt =
    parsedDate(args.page.lastEditedTime) ??
    parsedDate(args.page.createdTime) ??
    args.occurredAt;
  await recordConnectorMemoryDocument({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    adapter: normalizedConnectorMemoryDocumentAdapter,
    input: {
      provider: "notion",
      sourceType: "notion_page_event",
      externalId,
      title: args.page.title,
      content: notionPageDocumentContent({
        page: args.page,
        parent: args.parent,
        workspaceName: args.workspaceName,
        eventFamily: args.eventFamily,
        eventType: args.eventType,
      }),
      occurredAt,
      contextSpace: notionContextSpace({
        connectorId: args.connectorId,
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
      }),
      metadata: {
        provider: "notion",
        sourceType: "notion_page_event",
        externalUrl: args.page.url,
        pageId: args.page.id,
        pageUrl: args.page.url,
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
        reason: args.reason,
      },
      citation: {
        url: args.page.url,
        locator: args.eventFamily,
      },
    },
  });

  return await enqueueMemorySourceRelationshipExtractionJob(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "notion",
    sourceExternalId: externalId,
    connectorId: args.connectorId,
    priority: 40,
    reason: args.reason,
    replaceExisting: true,
  });
}

export async function recordNotionBackfillPageMemorySource(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly page: NotionPageMemorySourcePage;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly reason: string;
}): Promise<boolean> {
  const externalId = notionBackfillPageExternalId({
    connectorId: args.connectorId,
    pageId: args.page.id,
  });
  const contentHash = memoryContentHash(
    [
      args.page.title ?? "",
      args.page.url ?? "",
      args.page.lastEditedTime ?? "",
    ].join("\n"),
  );
  const occurredAt =
    parsedDate(args.page.lastEditedTime) ??
    parsedDate(args.page.createdTime) ??
    null;

  const didRecord = await recordMemorySource(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "notion",
    sourceType: "notion_page",
    externalId,
    connectorId: args.connectorId,
    occurredAt,
    title: args.page.title,
    contentHash,
    metadata: {
      notionWorkspaceId: args.workspaceId ?? undefined,
      notionWorkspaceName: args.workspaceName,
      notionPageId: args.page.id,
      notionPageUrl: args.page.url,
      notionLastEditedTime: args.page.lastEditedTime,
      notionScopeType: "page",
      notionScopeId: args.page.id,
      direction: "unknown",
      reason: args.reason,
    },
  });
  if (!didRecord) {
    return false;
  }

  await recordConnectorMemoryDocument({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    adapter: normalizedConnectorMemoryDocumentAdapter,
    input: {
      provider: "notion",
      sourceType: "notion_page",
      externalId,
      title: args.page.title,
      content: notionPageDocumentContent({
        page: args.page,
        workspaceName: args.workspaceName,
      }),
      occurredAt,
      contextSpace: notionContextSpace({
        connectorId: args.connectorId,
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
      }),
      metadata: {
        provider: "notion",
        sourceType: "notion_page",
        externalUrl: args.page.url,
        pageId: args.page.id,
        pageUrl: args.page.url,
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
        reason: args.reason,
      },
      citation: {
        url: args.page.url,
        locator: args.page.id,
      },
    },
  });

  return await enqueueMemorySourceRelationshipExtractionJob(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "notion",
    sourceExternalId: externalId,
    connectorId: args.connectorId,
    priority: 45,
    reason: args.reason,
    replaceExisting: true,
  });
}
