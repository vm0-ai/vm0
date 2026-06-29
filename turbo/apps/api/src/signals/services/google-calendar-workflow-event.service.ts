import { randomBytes, randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { googleCalendarEventCreatedEventConfigSchema } from "@vm0/api-contracts/contracts/zero-workflows";
import { refreshGoogleToken } from "@vm0/connectors/auth-providers/oauth/google";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { connectors } from "@vm0/db/schema/connector";
import {
  googleCalendarEventSnapshots,
  googleCalendarProcessedEvents,
  googleCalendarWatchStates,
} from "@vm0/db/schema/google-calendar-event";
import { secrets as secretsTable } from "@vm0/db/schema/secret";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import {
  buildChatOnlyWorkflowTriggerCallbacks,
  runWorkflowTriggerNow$,
  type TriggerRow,
} from "./zero-workflow-trigger-run.service";
import { ensureWorkflowUserTriggerThread } from "./zero-workflow-user-trigger-thread.service";

const log = logger("api:google-calendar-workflow-event");

const GOOGLE_CALENDAR_ACCESS_TOKEN_SECRET = "GOOGLE_CALENDAR_ACCESS_TOKEN";
const GOOGLE_CALENDAR_REFRESH_TOKEN_SECRET = "GOOGLE_CALENDAR_REFRESH_TOKEN";
const CONNECTOR_SECRET_TYPE = "connector";
const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WATCH_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const WATCH_TTL_SECONDS = 7 * 24 * 60 * 60;
const CALENDAR_EVENTS_PAGE_SIZE = 2500;
const DEFAULT_CALENDAR_ID = "primary";
const ATTENDEE_PROMPT_LIMIT = 20;

interface GoogleCalendarAccess {
  readonly connectorId: string;
  readonly emailAddress: string | null;
  readonly accessToken: string;
}

type GoogleCalendarAccessResult =
  | { readonly kind: "ok"; readonly access: GoogleCalendarAccess }
  | { readonly kind: "bad_request"; readonly message: string };

interface GoogleCalendarConnectorAccessRow {
  readonly id: string;
  readonly externalEmail: string | null;
  readonly tokenExpiresAt: Date | null;
  readonly needsReconnect: boolean;
}

interface ConnectorSecretRow {
  readonly name: string;
  readonly encryptedValue: string;
}

interface GoogleCalendarConnectorSecrets {
  readonly accessSecret: ConnectorSecretRow | null;
  readonly refreshSecret: ConnectorSecretRow | null;
}

type EnsureGoogleCalendarWatchResult =
  | { readonly kind: "ok" }
  | { readonly kind: "bad_request"; readonly message: string };

interface GoogleCalendarFetchOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface GoogleCalendarFetchError {
  readonly kind: "error";
  readonly status: number;
  readonly message: string;
}

type GoogleCalendarFetchResult<T> =
  | GoogleCalendarFetchOk<T>
  | GoogleCalendarFetchError;

const calendarWatchResponseSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  resourceUri: z.string(),
  expiration: z.union([z.string(), z.number()]).optional(),
});

const calendarEventDateTimeSchema = z
  .object({
    date: z.string().optional(),
    dateTime: z.string().optional(),
    timeZone: z.string().optional(),
  })
  .passthrough();

const calendarEventPersonSchema = z
  .object({
    email: z.string().optional(),
    displayName: z.string().optional(),
    self: z.boolean().optional(),
  })
  .passthrough();

const calendarEventAttendeeSchema = calendarEventPersonSchema.extend({
  responseStatus: z.string().optional(),
});

const calendarEventSchema = z
  .object({
    id: z.string(),
    etag: z.string().optional(),
    status: z.string().optional(),
    htmlLink: z.string().optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    eventType: z.string().optional(),
    start: calendarEventDateTimeSchema.optional(),
    end: calendarEventDateTimeSchema.optional(),
    organizer: calendarEventPersonSchema.optional(),
    creator: calendarEventPersonSchema.optional(),
    attendees: z.array(calendarEventAttendeeSchema).optional(),
    recurringEventId: z.string().optional(),
    originalStartTime: calendarEventDateTimeSchema.optional(),
  })
  .passthrough();

const calendarEventsListResponseSchema = z.object({
  items: z.array(calendarEventSchema).optional(),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
});

type GoogleCalendarEvent = z.infer<typeof calendarEventSchema>;
type GoogleCalendarWatchStateRow =
  typeof googleCalendarWatchStates.$inferSelect;

interface GoogleCalendarEventTriggerRow {
  readonly trigger: TriggerRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
}

interface GoogleCalendarWebhookNotification {
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
  readonly resourceState: string;
  readonly messageNumber: string | null;
}

interface CalendarEventContext {
  readonly calendarId: string;
  readonly eventId: string;
  readonly summary: string | null;
  readonly status: string | null;
  readonly eventType: string | null;
  readonly htmlLink: string | null;
  readonly start: GoogleCalendarEvent["start"] | null;
  readonly end: GoogleCalendarEvent["end"] | null;
  readonly organizer: GoogleCalendarEvent["organizer"] | null;
  readonly attendees: readonly z.infer<typeof calendarEventAttendeeSchema>[];
  readonly created: string | null;
  readonly updated: string | null;
  readonly recurringEventId: string | null;
  readonly originalStartTime: GoogleCalendarEvent["originalStartTime"] | null;
}

type GoogleCalendarFeatureGateChecker = (
  orgId: string,
  userId: string,
) => Promise<boolean>;

type GoogleCalendarRunStarter = (args: {
  readonly trigger: GoogleCalendarEventTriggerRow;
  readonly state: GoogleCalendarWatchStateRow;
  readonly notification: GoogleCalendarWebhookNotification;
  readonly event: CalendarEventContext;
}) => Promise<"ok" | "error">;

export interface GoogleCalendarWorkflowRunStartTestInput {
  readonly triggerId: string;
  readonly workflowName: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly summary: string | null;
}

type GoogleCalendarRunStarterTestOverride = (
  args: GoogleCalendarWorkflowRunStartTestInput,
) => Promise<"ok" | "error">;

const googleCalendarRunStarterOverride = testOverride<
  GoogleCalendarRunStarterTestOverride | undefined
>(() => {
  return undefined;
});

export function setGoogleCalendarWorkflowRunStarterForTests(
  starter: GoogleCalendarRunStarterTestOverride,
): () => void {
  googleCalendarRunStarterOverride.set(starter);
  return () => {
    googleCalendarRunStarterOverride.clear();
  };
}

type GoogleCalendarDispatchStateResult =
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "run_error"; readonly message: string };

type GoogleCalendarWebhookResult =
  | {
      readonly kind: "ok";
      readonly watchStates: number;
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "run_error"; readonly message: string };

function tokenNeedsRefresh(
  tokenExpiresAt: Date | null,
  currentTime: Date,
): boolean {
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

async function loadGoogleCalendarConnector(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId?: string;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarConnectorAccessRow | null> {
  const connectorConditions = [
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.type, "google-calendar"),
  ];
  if (args.connectorId !== undefined) {
    connectorConditions.push(eq(connectors.id, args.connectorId));
  }

  const [connector] = await args.db
    .select({
      id: connectors.id,
      externalEmail: connectors.externalEmail,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
    })
    .from(connectors)
    .where(and(...connectorConditions))
    .limit(1);
  args.signal.throwIfAborted();

  return connector ?? null;
}

async function loadGoogleCalendarConnectorSecrets(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarConnectorSecrets> {
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
        return row.name === GOOGLE_CALENDAR_ACCESS_TOKEN_SECRET;
      }) ?? null,
    refreshSecret:
      secretRows.find((row) => {
        return row.name === GOOGLE_CALENDAR_REFRESH_TOKEN_SECRET;
      }) ?? null,
  };
}

async function markGoogleCalendarConnectorNeedsReconnect(args: {
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

async function refreshGoogleCalendarAccessToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connector: GoogleCalendarConnectorAccessRow;
  readonly refreshSecret: ConnectorSecretRow;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarAccessResult> {
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return {
      kind: "bad_request",
      message: "Google OAuth client env vars are not configured",
    };
  }

  const refreshToken = await decryptStoredSecretValue(
    args.refreshSecret.encryptedValue,
  );
  const refreshResult = await settle(
    refreshGoogleToken(
      "google-calendar",
      clientId,
      clientSecret,
      refreshToken,
      args.signal,
    ),
    args.signal,
  );
  if (!refreshResult.ok) {
    await markGoogleCalendarConnectorNeedsReconnect({
      db: args.db,
      connectorId: args.connector.id,
      currentTime: args.currentTime,
      signal: args.signal,
    });
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Calendar before using Google Calendar event triggers",
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
        eq(secretsTable.name, GOOGLE_CALENDAR_ACCESS_TOKEN_SECRET),
      ),
    );
  args.signal.throwIfAborted();

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
      emailAddress: args.connector.externalEmail,
      accessToken: refreshResult.value.accessToken,
    },
  };
}

async function resolveGoogleCalendarAccess(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId?: string;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarAccessResult> {
  const currentTime = nowDate();
  const connector = await loadGoogleCalendarConnector(args);
  if (!connector) {
    return {
      kind: "bad_request",
      message:
        "Connect Google Calendar before adding a Google Calendar event trigger",
    };
  }
  if (connector.needsReconnect) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Calendar before using Google Calendar event triggers",
    };
  }

  const { accessSecret, refreshSecret } =
    await loadGoogleCalendarConnectorSecrets(args);
  if (!accessSecret) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Calendar before using Google Calendar event triggers",
    };
  }

  if (!tokenNeedsRefresh(connector.tokenExpiresAt, currentTime)) {
    return {
      kind: "ok",
      access: {
        connectorId: connector.id,
        emailAddress: connector.externalEmail,
        accessToken: await decryptStoredSecretValue(
          accessSecret.encryptedValue,
        ),
      },
    };
  }

  if (!refreshSecret) {
    await markGoogleCalendarConnectorNeedsReconnect({
      db: args.db,
      connectorId: connector.id,
      currentTime,
      signal: args.signal,
    });
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Calendar before using Google Calendar event triggers",
    };
  }

  return await refreshGoogleCalendarAccessToken({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    connector,
    refreshSecret,
    currentTime,
    signal: args.signal,
  });
}

function calendarApiUrl(path: string): string {
  return `${GOOGLE_CALENDAR_API_BASE}${path}`;
}

function calendarEventsUrl(calendarId: string): string {
  return calendarApiUrl(`/calendars/${encodeURIComponent(calendarId)}/events`);
}

function googleCalendarWebhookUrl(): string {
  const baseUrl = optionalEnv("VM0_API_BACKEND_URL") ?? env("VM0_API_URL");
  return new URL("/api/webhooks/google-calendar", baseUrl).toString();
}

async function googleCalendarFetchJson<T>(
  schema: z.ZodType<T>,
  accessToken: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<GoogleCalendarFetchResult<T>> {
  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: await response.text(),
    };
  }

  return { kind: "ok", value: schema.parse(await response.json()) };
}

async function googleCalendarFetchNoContent(args: {
  readonly accessToken: string;
  readonly url: string;
  readonly init: RequestInit;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarFetchResult<null>> {
  const response = await fetch(args.url, {
    ...args.init,
    signal: args.signal,
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      ...args.init.headers,
    },
  });
  if (!response.ok) {
    return {
      kind: "error",
      status: response.status,
      message: await response.text(),
    };
  }
  return { kind: "ok", value: null };
}

function mintChannelToken(): string {
  return randomBytes(32).toString("base64url");
}

function watchExpirationDate(
  expiration: string | number | undefined,
  currentTime: Date,
): Date {
  const millis = expiration === undefined ? Number.NaN : Number(expiration);
  if (Number.isFinite(millis)) {
    return new Date(millis);
  }
  return new Date(currentTime.getTime() + WATCH_TTL_SECONDS * 1000);
}

async function watchCalendarEvents(args: {
  readonly accessToken: string;
  readonly calendarId: string;
  readonly channelId: string;
  readonly channelToken: string;
  readonly signal: AbortSignal;
}): Promise<
  GoogleCalendarFetchResult<z.infer<typeof calendarWatchResponseSchema>>
> {
  return await googleCalendarFetchJson(
    calendarWatchResponseSchema,
    args.accessToken,
    `${calendarEventsUrl(args.calendarId)}/watch`,
    {
      method: "POST",
      body: JSON.stringify({
        id: args.channelId,
        type: "web_hook",
        address: googleCalendarWebhookUrl(),
        token: args.channelToken,
        params: { ttl: String(WATCH_TTL_SECONDS) },
      }),
    },
    args.signal,
  );
}

async function stopCalendarChannel(args: {
  readonly accessToken: string;
  readonly channelId: string;
  readonly resourceId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const result = await googleCalendarFetchNoContent({
    accessToken: args.accessToken,
    url: calendarApiUrl("/channels/stop"),
    init: {
      method: "POST",
      body: JSON.stringify({
        id: args.channelId,
        resourceId: args.resourceId,
      }),
    },
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (result.kind !== "ok") {
    log.warn("Failed to stop Google Calendar watch channel", {
      channelId: args.channelId,
      resourceId: args.resourceId,
      status: result.status,
      message: result.message,
    });
  }
}

type CalendarEventsListResult =
  | {
      readonly kind: "ok";
      readonly events: readonly GoogleCalendarEvent[];
      readonly nextSyncToken: string;
    }
  | { readonly kind: "stale_cursor" }
  | { readonly kind: "calendar_error"; readonly message: string };
type CalendarEventsListOk = Extract<
  CalendarEventsListResult,
  { readonly kind: "ok" }
>;

async function listCalendarEvents(args: {
  readonly accessToken: string;
  readonly calendarId: string;
  readonly syncToken?: string | null;
  readonly signal: AbortSignal;
}): Promise<CalendarEventsListResult> {
  let pageToken: string | null = null;
  const events: GoogleCalendarEvent[] = [];
  let nextSyncToken: string | null = null;

  do {
    const url = new URL(calendarEventsUrl(args.calendarId));
    url.searchParams.set("maxResults", String(CALENDAR_EVENTS_PAGE_SIZE));
    url.searchParams.set("showDeleted", "true");
    if (args.syncToken) {
      url.searchParams.set("syncToken", args.syncToken);
    }
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const result = await googleCalendarFetchJson(
      calendarEventsListResponseSchema,
      args.accessToken,
      url.toString(),
      { method: "GET" },
      args.signal,
    );
    args.signal.throwIfAborted();
    if (result.kind !== "ok") {
      return result.status === 410
        ? { kind: "stale_cursor" }
        : { kind: "calendar_error", message: result.message };
    }

    events.push(...(result.value.items ?? []));
    pageToken = result.value.nextPageToken ?? null;
    nextSyncToken = result.value.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  if (!nextSyncToken) {
    return {
      kind: "calendar_error",
      message: "Google Calendar did not return a nextSyncToken",
    };
  }

  return { kind: "ok", events, nextSyncToken };
}

function parseGoogleDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventStartDate(event: GoogleCalendarEvent): Date | null {
  return parseGoogleDate(event.start?.dateTime ?? event.start?.date);
}

function eventEndDate(event: GoogleCalendarEvent): Date | null {
  return parseGoogleDate(event.end?.dateTime ?? event.end?.date);
}

function eventPromptContext(
  calendarId: string,
  event: GoogleCalendarEvent,
): CalendarEventContext {
  return {
    calendarId,
    eventId: event.id,
    summary: event.summary ?? null,
    status: event.status ?? null,
    eventType: event.eventType ?? null,
    htmlLink: event.htmlLink ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    organizer: event.organizer ?? null,
    attendees: event.attendees ?? [],
    created: event.created ?? null,
    updated: event.updated ?? null,
    recurringEventId: event.recurringEventId ?? null,
    originalStartTime: event.originalStartTime ?? null,
  };
}

function eventSnapshotValue(
  event: GoogleCalendarEvent,
): Record<string, unknown> {
  return structuredClone({
    id: event.id,
    etag: event.etag,
    status: event.status,
    eventType: event.eventType,
    summary: event.summary,
    htmlLink: event.htmlLink,
    start: event.start,
    end: event.end,
    organizer: event.organizer,
    attendees: event.attendees,
    created: event.created,
    updated: event.updated,
    recurringEventId: event.recurringEventId,
    originalStartTime: event.originalStartTime,
  }) as Record<string, unknown>;
}

function eventSnapshotRow(args: {
  readonly watchStateId: string;
  readonly event: GoogleCalendarEvent;
  readonly currentTime: Date;
}) {
  return {
    watchStateId: args.watchStateId,
    calendarEventId: args.event.id,
    etag: args.event.etag ?? null,
    status: args.event.status ?? null,
    eventType: args.event.eventType ?? null,
    summary: args.event.summary ?? null,
    startAt: eventStartDate(args.event),
    endAt: eventEndDate(args.event),
    eventCreatedAt: parseGoogleDate(args.event.created),
    eventUpdatedAt: parseGoogleDate(args.event.updated),
    snapshot: eventSnapshotValue(args.event),
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

async function upsertCalendarEventSnapshots(args: {
  readonly db: Db;
  readonly watchStateId: string;
  readonly events: readonly GoogleCalendarEvent[];
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.events.length === 0) {
    return;
  }

  await args.db
    .insert(googleCalendarEventSnapshots)
    .values(
      args.events.map((event) => {
        return eventSnapshotRow({
          watchStateId: args.watchStateId,
          event,
          currentTime: args.currentTime,
        });
      }),
    )
    .onConflictDoUpdate({
      target: [
        googleCalendarEventSnapshots.watchStateId,
        googleCalendarEventSnapshots.calendarEventId,
      ],
      set: {
        etag: sql`excluded.etag`,
        status: sql`excluded.status`,
        eventType: sql`excluded.event_type`,
        summary: sql`excluded.summary`,
        startAt: sql`excluded.start_at`,
        endAt: sql`excluded.end_at`,
        eventCreatedAt: sql`excluded.event_created_at`,
        eventUpdatedAt: sql`excluded.event_updated_at`,
        snapshot: sql`excluded.snapshot`,
        updatedAt: args.currentTime,
      },
    });
  args.signal.throwIfAborted();
}

async function baselineCalendarWatchState(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<EnsureGoogleCalendarWatchResult> {
  const baseline = await listCalendarEvents({
    accessToken: args.accessToken,
    calendarId: args.state.calendarId,
    syncToken: null,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (baseline.kind !== "ok") {
    return {
      kind: "bad_request",
      message:
        baseline.kind === "stale_cursor"
          ? "Failed to establish Google Calendar event trigger baseline"
          : baseline.message,
    };
  }

  const currentTime = nowDate();
  await upsertCalendarEventSnapshots({
    db: args.db,
    watchStateId: args.state.id,
    events: baseline.events,
    currentTime,
    signal: args.signal,
  });

  await args.db
    .update(googleCalendarWatchStates)
    .set({
      syncToken: baseline.nextSyncToken,
      needsRewatch: false,
      updatedAt: currentTime,
    })
    .where(eq(googleCalendarWatchStates.id, args.state.id));
  args.signal.throwIfAborted();

  return { kind: "ok" };
}

async function loadCalendarWatchState(args: {
  readonly db: Db;
  readonly connectorId: string;
  readonly calendarId: string;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarWatchStateRow | null> {
  const [state] = await args.db
    .select()
    .from(googleCalendarWatchStates)
    .where(
      and(
        eq(googleCalendarWatchStates.connectorId, args.connectorId),
        eq(googleCalendarWatchStates.calendarId, args.calendarId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return state ?? null;
}

function watchNeedsRefresh(
  state: GoogleCalendarWatchStateRow,
  currentTime: Date,
): boolean {
  return (
    state.needsRewatch ||
    state.syncToken === null ||
    state.watchExpirationAt.getTime() <=
      currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS
  );
}

async function registerCalendarWatch(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly access: GoogleCalendarAccess;
  readonly calendarId: string;
  readonly previousState: GoogleCalendarWatchStateRow | null;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly kind: "ok"; readonly state: GoogleCalendarWatchStateRow }
  | { readonly kind: "bad_request"; readonly message: string }
> {
  const channelId = randomUUID();
  const channelToken = mintChannelToken();
  const currentTime = nowDate();
  const watch = await watchCalendarEvents({
    accessToken: args.access.accessToken,
    calendarId: args.calendarId,
    channelId,
    channelToken,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (watch.kind !== "ok") {
    return {
      kind: "bad_request",
      message:
        "Failed to register Google Calendar watch for event trigger setup",
    };
  }

  const [state] = await args.db
    .insert(googleCalendarWatchStates)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.access.connectorId,
      calendarId: args.calendarId,
      channelId,
      channelToken,
      resourceId: watch.value.resourceId,
      resourceUri: watch.value.resourceUri,
      syncToken: null,
      watchExpirationAt: watchExpirationDate(
        watch.value.expiration,
        currentTime,
      ),
      lastWatchRenewedAt: currentTime,
      needsRewatch: false,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        googleCalendarWatchStates.connectorId,
        googleCalendarWatchStates.calendarId,
      ],
      set: {
        orgId: args.orgId,
        userId: args.userId,
        channelId,
        channelToken,
        resourceId: watch.value.resourceId,
        resourceUri: watch.value.resourceUri,
        syncToken: null,
        watchExpirationAt: watchExpirationDate(
          watch.value.expiration,
          currentTime,
        ),
        lastWatchRenewedAt: currentTime,
        needsRewatch: false,
        updatedAt: currentTime,
      },
    })
    .returning();
  args.signal.throwIfAborted();
  if (!state) {
    return {
      kind: "bad_request",
      message: "Failed to persist Google Calendar watch state",
    };
  }

  const baseline = await baselineCalendarWatchState({
    db: args.db,
    state,
    accessToken: args.access.accessToken,
    signal: args.signal,
  });
  if (baseline.kind !== "ok") {
    return baseline;
  }

  if (args.previousState && args.previousState.channelId !== channelId) {
    await stopCalendarChannel({
      accessToken: args.access.accessToken,
      channelId: args.previousState.channelId,
      resourceId: args.previousState.resourceId,
      signal: args.signal,
    });
  }

  return {
    kind: "ok",
    state: {
      ...state,
      syncToken: null,
    },
  };
}

export async function ensureGoogleCalendarWatchForUser(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly calendarId?: string;
  readonly signal: AbortSignal;
}): Promise<EnsureGoogleCalendarWatchResult> {
  const calendarId = args.calendarId ?? DEFAULT_CALENDAR_ID;
  const accessResult = await resolveGoogleCalendarAccess(args);
  args.signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return accessResult;
  }

  const existing = await loadCalendarWatchState({
    db: args.db,
    connectorId: accessResult.access.connectorId,
    calendarId,
    signal: args.signal,
  });
  const currentTime = nowDate();
  if (existing && !watchNeedsRefresh(existing, currentTime)) {
    return { kind: "ok" };
  }

  const registered = await registerCalendarWatch({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    access: accessResult.access,
    calendarId,
    previousState: existing,
    signal: args.signal,
  });
  return registered.kind === "ok"
    ? { kind: "ok" }
    : { kind: "bad_request", message: registered.message };
}

export function googleCalendarWorkflowEventTriggersEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(
      FeatureSwitchKey.WorkflowGoogleCalendarEventTriggers,
      {
        orgId,
        userId,
        overrides,
      },
    );
  });
}

function decodeCalendarWebhookHeaders(
  headers: Headers,
): GoogleCalendarWebhookNotification | { readonly kind: "bad_request" } {
  const channelId = headers.get("x-goog-channel-id");
  const channelToken = headers.get("x-goog-channel-token");
  const resourceId = headers.get("x-goog-resource-id");
  const resourceState = headers.get("x-goog-resource-state");
  if (!channelId || !channelToken || !resourceId || !resourceState) {
    return { kind: "bad_request" };
  }
  return {
    channelId,
    channelToken,
    resourceId,
    resourceState,
    messageNumber: headers.get("x-goog-message-number"),
  };
}

async function loadCalendarWatchStateForNotification(args: {
  readonly db: Db;
  readonly notification: GoogleCalendarWebhookNotification;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarWatchStateRow | null> {
  const [state] = await args.db
    .select()
    .from(googleCalendarWatchStates)
    .where(
      and(
        eq(googleCalendarWatchStates.channelId, args.notification.channelId),
        eq(googleCalendarWatchStates.resourceId, args.notification.resourceId),
        eq(
          googleCalendarWatchStates.channelToken,
          args.notification.channelToken,
        ),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return state ?? null;
}

async function loadKnownCalendarEventIds(args: {
  readonly db: Db;
  readonly watchStateId: string;
  readonly events: readonly GoogleCalendarEvent[];
  readonly signal: AbortSignal;
}): Promise<Set<string>> {
  const ids = args.events.map((event) => {
    return event.id;
  });
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await args.db
    .select({ calendarEventId: googleCalendarEventSnapshots.calendarEventId })
    .from(googleCalendarEventSnapshots)
    .where(
      and(
        eq(googleCalendarEventSnapshots.watchStateId, args.watchStateId),
        inArray(googleCalendarEventSnapshots.calendarEventId, ids),
      ),
    );
  args.signal.throwIfAborted();
  return new Set(
    rows.map((row) => {
      return row.calendarEventId;
    }),
  );
}

async function loadGoogleCalendarEventTriggers(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarEventTriggerRow[]> {
  const triggerRows = await args.db
    .select({
      trigger: zeroWorkflowTriggers,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
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
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.state.orgId),
        eq(zeroWorkflowTriggers.ownerUserId, args.state.userId),
        eq(zeroWorkflowTriggers.enabled, true),
        eq(zeroWorkflowTriggers.kind, "event"),
        eq(zeroWorkflowTriggers.eventType, "google-calendar-event-created"),
      ),
    );
  args.signal.throwIfAborted();

  const currentTime = nowDate();
  const triggers: GoogleCalendarEventTriggerRow[] = [];
  for (const row of triggerRows) {
    const config = googleCalendarEventCreatedEventConfigSchema.safeParse(
      row.trigger.eventConfig,
    );
    if (!config.success || config.data.calendarId !== args.state.calendarId) {
      continue;
    }
    const chatThreadId =
      row.chatThreadId ??
      (await args.db.transaction(async (tx) => {
        return await ensureWorkflowUserTriggerThread(tx, {
          orgId: row.trigger.orgId,
          userId: row.trigger.ownerUserId,
          workflowId: row.trigger.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
    args.signal.throwIfAborted();
    triggers.push({
      trigger: row.trigger,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId,
    });
  }
  return triggers;
}

function buildGoogleCalendarWorkflowEventSystemPrompt(args: {
  readonly triggerId: string;
  readonly event: CalendarEventContext;
}): string {
  return [
    "# Current context",
    "You are running because a Google Calendar event-created workflow trigger matched a newly created calendar event.",
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "Use connected Google Calendar tools to inspect the calendar event if the workflow needs more detail.",
    "",
    "# Google Calendar event",
    JSON.stringify(
      {
        triggerId: args.triggerId,
        calendarId: args.event.calendarId,
        eventId: args.event.eventId,
        summary: args.event.summary,
        status: args.event.status,
        eventType: args.event.eventType,
        htmlLink: args.event.htmlLink,
        start: args.event.start,
        end: args.event.end,
        organizer: args.event.organizer,
        attendees: args.event.attendees.slice(0, ATTENDEE_PROMPT_LIMIT),
        attendeeCount: args.event.attendees.length,
        created: args.event.created,
        updated: args.event.updated,
        recurringEventId: args.event.recurringEventId,
        originalStartTime: args.event.originalStartTime,
      },
      null,
      2,
    ),
  ].join("\n");
}

async function insertGoogleCalendarProcessedEvent(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly trigger: GoogleCalendarEventTriggerRow;
  readonly notification: GoogleCalendarWebhookNotification;
  readonly event: CalendarEventContext;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const [processed] = await args.db
    .insert(googleCalendarProcessedEvents)
    .values({
      watchStateId: args.state.id,
      triggerId: args.trigger.trigger.id,
      channelId: args.state.channelId,
      resourceState: args.notification.resourceState,
      calendarEventId: args.event.eventId,
      eventCreatedAt: parseGoogleDate(args.event.created ?? undefined),
      eventUpdatedAt: parseGoogleDate(args.event.updated ?? undefined),
      createdAt: nowDate(),
    })
    .onConflictDoNothing()
    .returning({ id: googleCalendarProcessedEvents.id });
  args.signal.throwIfAborted();

  return processed?.id ?? null;
}

async function dispatchGoogleCalendarTriggerEvent(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly trigger: GoogleCalendarEventTriggerRow;
  readonly notification: GoogleCalendarWebhookNotification;
  readonly event: CalendarEventContext;
  readonly startRun: GoogleCalendarRunStarter;
  readonly signal: AbortSignal;
}): Promise<"dispatched" | "duplicate" | { readonly kind: "run_error" }> {
  const processedId = await insertGoogleCalendarProcessedEvent(args);
  if (!processedId) {
    return "duplicate";
  }

  const result = await args.startRun({
    trigger: args.trigger,
    state: args.state,
    notification: args.notification,
    event: args.event,
  });
  args.signal.throwIfAborted();
  if (result !== "ok") {
    await args.db
      .delete(googleCalendarProcessedEvents)
      .where(eq(googleCalendarProcessedEvents.id, processedId));
    args.signal.throwIfAborted();
    return { kind: "run_error" };
  }

  return "dispatched";
}

async function dispatchCreatedCalendarEvents(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly notification: GoogleCalendarWebhookNotification;
  readonly events: readonly GoogleCalendarEvent[];
  readonly triggers: readonly GoogleCalendarEventTriggerRow[];
  readonly startRun: GoogleCalendarRunStarter;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarDispatchStateResult> {
  if (args.triggers.length === 0 || args.events.length === 0) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  let dispatched = 0;
  let duplicates = 0;
  for (const event of args.events) {
    const context = eventPromptContext(args.state.calendarId, event);
    for (const trigger of args.triggers) {
      const result = await dispatchGoogleCalendarTriggerEvent({
        db: args.db,
        state: args.state,
        trigger,
        notification: args.notification,
        event: context,
        startRun: args.startRun,
        signal: args.signal,
      });
      if (typeof result !== "string") {
        return {
          kind: "run_error",
          message: "Failed to start Google Calendar event workflow run",
        };
      }
      dispatched += result === "dispatched" ? 1 : 0;
      duplicates += result === "duplicate" ? 1 : 0;
    }
  }

  return { kind: "ok", dispatched, duplicates };
}

async function dispatchGoogleCalendarChanges(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly notification: GoogleCalendarWebhookNotification;
  readonly changes: CalendarEventsListOk;
  readonly startRun: GoogleCalendarRunStarter;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarDispatchStateResult> {
  const knownIds = await loadKnownCalendarEventIds({
    db: args.db,
    watchStateId: args.state.id,
    events: args.changes.events,
    signal: args.signal,
  });
  const createdEvents = args.changes.events.filter((event) => {
    return event.status !== "cancelled" && !knownIds.has(event.id);
  });

  const triggers = await loadGoogleCalendarEventTriggers({
    db: args.db,
    state: args.state,
    signal: args.signal,
  });
  const result = await dispatchCreatedCalendarEvents({
    db: args.db,
    state: args.state,
    notification: args.notification,
    events: createdEvents,
    triggers,
    startRun: args.startRun,
    signal: args.signal,
  });
  if (result.kind !== "ok") {
    return result;
  }

  const currentTime = nowDate();
  await upsertCalendarEventSnapshots({
    db: args.db,
    watchStateId: args.state.id,
    events: args.changes.events,
    currentTime,
    signal: args.signal,
  });

  await args.db
    .update(googleCalendarWatchStates)
    .set({
      syncToken: args.changes.nextSyncToken,
      needsRewatch: false,
      updatedAt: currentTime,
    })
    .where(eq(googleCalendarWatchStates.id, args.state.id));
  args.signal.throwIfAborted();

  return result;
}

async function dispatchGoogleCalendarWatchState(args: {
  readonly db: Db;
  readonly state: GoogleCalendarWatchStateRow;
  readonly notification: GoogleCalendarWebhookNotification;
  readonly isFeatureEnabledForOwner: GoogleCalendarFeatureGateChecker;
  readonly startRun: GoogleCalendarRunStarter;
  readonly signal: AbortSignal;
}): Promise<GoogleCalendarDispatchStateResult> {
  const gateEnabled = await args.isFeatureEnabledForOwner(
    args.state.orgId,
    args.state.userId,
  );
  args.signal.throwIfAborted();
  if (!gateEnabled) {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const access = await resolveGoogleCalendarAccess({
    db: args.db,
    orgId: args.state.orgId,
    userId: args.state.userId,
    connectorId: args.state.connectorId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (access.kind !== "ok") {
    log.warn(
      "Google Calendar event skipped because connector access is unavailable",
      {
        watchStateId: args.state.id,
        message: access.message,
      },
    );
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  if (args.notification.resourceState === "sync") {
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  if (args.notification.resourceState === "not_exists") {
    await args.db
      .update(googleCalendarWatchStates)
      .set({ needsRewatch: true, updatedAt: nowDate() })
      .where(eq(googleCalendarWatchStates.id, args.state.id));
    args.signal.throwIfAborted();
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  if (!args.state.syncToken) {
    const baseline = await baselineCalendarWatchState({
      db: args.db,
      state: args.state,
      accessToken: access.access.accessToken,
      signal: args.signal,
    });
    if (baseline.kind !== "ok") {
      log.warn("Google Calendar baseline sync failed", {
        watchStateId: args.state.id,
        message: baseline.message,
      });
    }
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  const changes = await listCalendarEvents({
    accessToken: access.access.accessToken,
    calendarId: args.state.calendarId,
    syncToken: args.state.syncToken,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (changes.kind === "stale_cursor") {
    const baseline = await baselineCalendarWatchState({
      db: args.db,
      state: args.state,
      accessToken: access.access.accessToken,
      signal: args.signal,
    });
    if (baseline.kind !== "ok") {
      log.warn("Google Calendar stale cursor baseline sync failed", {
        watchStateId: args.state.id,
        message: baseline.message,
      });
    }
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }
  if (changes.kind === "calendar_error") {
    log.warn("Google Calendar event sync failed", {
      watchStateId: args.state.id,
      message: changes.message,
    });
    return { kind: "ok", dispatched: 0, duplicates: 0 };
  }

  return await dispatchGoogleCalendarChanges({
    db: args.db,
    state: args.state,
    notification: args.notification,
    changes,
    startRun: args.startRun,
    signal: args.signal,
  });
}

export const dispatchGoogleCalendarWebhook$ = command(
  async (
    { get, set },
    args: {
      readonly headers: Headers;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleCalendarWebhookResult> => {
    const notification = decodeCalendarWebhookHeaders(args.headers);
    if ("kind" in notification) {
      return {
        kind: "bad_request",
        message: "Missing Google Calendar webhook headers",
      };
    }

    const db = set(writeDb$);
    const state = await loadCalendarWatchStateForNotification({
      db,
      notification,
      signal,
    });
    if (!state) {
      return { kind: "unauthorized" };
    }

    const isFeatureEnabledForOwner: GoogleCalendarFeatureGateChecker = async (
      orgId,
      userId,
    ) => {
      return await get(
        googleCalendarWorkflowEventTriggersEnabledForOwner(orgId, userId),
      );
    };
    const runStarterOverride = googleCalendarRunStarterOverride.get();
    const startRun: GoogleCalendarRunStarter = runStarterOverride
      ? async ({ trigger, state, event }) => {
          return await runStarterOverride({
            triggerId: trigger.trigger.id,
            workflowName: trigger.workflowName,
            calendarId: state.calendarId,
            eventId: event.eventId,
            summary: event.summary,
          });
        }
      : async ({ trigger, event }) => {
          const result = await set(
            runWorkflowTriggerNow$,
            {
              due: {
                trigger: trigger.trigger,
                agentId: trigger.agentId,
                workflowName: trigger.workflowName,
                chatThreadId: trigger.chatThreadId,
              },
              apiStartTime: args.apiStartTime,
              triggerSource: "workflow-event",
              appendSystemPrompt: buildGoogleCalendarWorkflowEventSystemPrompt({
                triggerId: trigger.trigger.id,
                event,
              }),
              callbacks: buildChatOnlyWorkflowTriggerCallbacks(
                trigger.chatThreadId,
                trigger.agentId,
              ),
              activePreviousRunPolicy: "allow",
              recordLastRunId: false,
              recordLastRunAt: true,
              dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            },
            signal,
          );
          signal.throwIfAborted();
          return result.kind === "ok" ? "ok" : "error";
        };

    const result = await dispatchGoogleCalendarWatchState({
      db,
      state,
      notification,
      isFeatureEnabledForOwner,
      startRun,
      signal,
    });
    if (result.kind !== "ok") {
      return result;
    }

    return {
      kind: "ok",
      watchStates: 1,
      dispatched: result.dispatched,
      duplicates: result.duplicates,
    };
  },
);

export const renewGoogleCalendarWatches$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const renewBefore = new Date(
      currentTime.getTime() + WATCH_RENEWAL_WINDOW_MS,
    );
    const states = await db
      .select()
      .from(googleCalendarWatchStates)
      .where(
        or(
          eq(googleCalendarWatchStates.needsRewatch, true),
          lte(googleCalendarWatchStates.watchExpirationAt, renewBefore),
        ),
      );
    signal.throwIfAborted();

    let renewed = 0;
    let failed = 0;
    for (const state of states) {
      const access = await resolveGoogleCalendarAccess({
        db,
        orgId: state.orgId,
        userId: state.userId,
        connectorId: state.connectorId,
        signal,
      });
      signal.throwIfAborted();
      if (access.kind !== "ok") {
        failed++;
        continue;
      }

      const registered = await registerCalendarWatch({
        db,
        orgId: state.orgId,
        userId: state.userId,
        access: access.access,
        calendarId: state.calendarId,
        previousState: state,
        signal,
      });
      signal.throwIfAborted();
      if (registered.kind !== "ok") {
        failed++;
        continue;
      }
      renewed++;
    }

    return { renewed, failed };
  },
);
