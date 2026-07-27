/**
 * Server-side collectors for the Morning Brief input bundle.
 *
 * Connector sources (GitHub, Gmail, Google Calendar) resolve the member's
 * connector access token through the shared credential runtime and pull a
 * bounded window of data. The chat-threads source reads unread vm0 chat
 * threads straight from the database. Each source reports independently: a
 * failed source is annotated in the input JSON instead of blocking the brief.
 */
import { z } from "zod";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  type SQL,
} from "drizzle-orm";

import { env } from "../../lib/env";
import type { Db } from "../external/db";
import { settle } from "../utils";
import { nowDate } from "../external/time";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
} from "./connector-credential-runtime.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import { projectStructuredUserMessage } from "./zero-chat-structured-message.service";
import { effectiveChatMessageStructuredPrompt } from "./zero-chat-structured-message-storage.service";

const GITHUB_API_BASE = "https://api.github.com";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_GMAIL_MESSAGES = 25;
const MAX_GITHUB_NOTIFICATIONS = 50;
const MAX_GITHUB_SEARCH_RESULTS = 25;
const MAX_CALENDAR_EVENTS = 50;
const MAX_UNREAD_THREADS = 10;
const MAX_THREAD_MESSAGES = 3;

const MORNING_BRIEF_CONNECTOR_REFS = [
  "github",
  "gmail",
  "google-calendar",
] as const;
type MorningBriefConnectorRef = (typeof MORNING_BRIEF_CONNECTOR_REFS)[number];

function connectorTokenEnvironmentName(
  connectorRef: MorningBriefConnectorRef,
): string {
  switch (connectorRef) {
    case "github": {
      return "GH_TOKEN";
    }
    case "gmail": {
      return "GMAIL_TOKEN";
    }
    case "google-calendar": {
      return "GOOGLE_CALENDAR_TOKEN";
    }
  }
}

interface ConnectorAccess {
  readonly accessToken: string;
  readonly externalEmail: string | null;
}

type ConnectorAccessResult =
  | { readonly kind: "ok"; readonly access: ConnectorAccess }
  | { readonly kind: "unavailable"; readonly message: string };

async function resolveMorningBriefConnectorAccess(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorRef: MorningBriefConnectorRef;
  readonly signal: AbortSignal;
}): Promise<ConnectorAccessResult> {
  const environmentName = connectorTokenEnvironmentName(args.connectorRef);
  const currentTime = nowDate();
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  args.signal.throwIfAborted();
  const loaded = await loadConnectorCredentialConnection({
    db: args.db,
    snapshot,
    orgId: args.orgId,
    userId: args.userId,
    connectorRef: args.connectorRef,
  });
  args.signal.throwIfAborted();
  if (loaded.kind !== "ok") {
    return {
      kind: "unavailable",
      message: `${args.connectorRef} is not connected`,
    };
  }
  if (loaded.connection.needsReconnect) {
    return {
      kind: "unavailable",
      message: `${args.connectorRef} needs to be reconnected`,
    };
  }
  const connection = loaded.connection;

  const tokenExpiresAt = connection.tokenExpiresAt;
  const supportsRefresh =
    connection.runtimeMethod.method.access.kind === "refresh-token";
  const needsRefresh =
    supportsRefresh &&
    (!tokenExpiresAt ||
      tokenExpiresAt.getTime() <=
        currentTime.getTime() + TOKEN_REFRESH_BUFFER_MS);
  if (needsRefresh) {
    const refreshed = await refreshConnectorCredentialAccess({
      connection,
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      runtimeEnvironmentName: environmentName,
      signal: args.signal,
      persist: { db: args.db, markNeedsReconnectOnFailure: true },
    });
    if (refreshed.kind === "ok") {
      return {
        kind: "ok",
        access: {
          accessToken: refreshed.accessToken,
          externalEmail: connection.externalEmail,
        },
      };
    }
    if (refreshed.kind !== "not-refreshable") {
      return {
        kind: "unavailable",
        message: `${args.connectorRef} token refresh failed`,
      };
    }
  }

  const valueRef = connectorCredentialRuntimeValueRef(
    connection,
    environmentName,
  );
  if (valueRef === null) {
    return {
      kind: "unavailable",
      message: `${args.connectorRef} needs to be reconnected`,
    };
  }
  const values = await loadConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [valueRef],
  });
  args.signal.throwIfAborted();
  const accessToken = values.get(valueRef);
  if (!accessToken) {
    return {
      kind: "unavailable",
      message: `${args.connectorRef} needs to be reconnected`,
    };
  }
  return {
    kind: "ok",
    access: {
      accessToken,
      externalEmail: connection.externalEmail,
    },
  };
}

async function fetchJson<T>(
  schema: z.ZodType<T>,
  url: string,
  accessToken: string,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...extraHeaders,
    },
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return schema.parse(await response.json());
}

// --- GitHub -----------------------------------------------------------------

const githubNotificationSchema = z.object({
  reason: z.string(),
  updated_at: z.string(),
  subject: z.object({
    title: z.string(),
    url: z.string().nullable(),
    type: z.string(),
  }),
  repository: z.object({ full_name: z.string() }),
});

const githubSearchItemSchema = z.object({
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  updated_at: z.string(),
  draft: z.boolean().optional(),
  pull_request: z.object({ merged_at: z.string().nullable() }).optional(),
  repository_url: z.string(),
});

const githubSearchResponseSchema = z.object({
  items: z.array(githubSearchItemSchema),
});

export interface MorningBriefGithubData {
  readonly login: string | null;
  readonly notifications: readonly z.infer<typeof githubNotificationSchema>[];
  readonly reviewRequests: readonly z.infer<typeof githubSearchItemSchema>[];
  readonly myOpenPullRequests: readonly z.infer<
    typeof githubSearchItemSchema
  >[];
  readonly involvedItems: readonly z.infer<typeof githubSearchItemSchema>[];
}

const githubUserSchema = z.object({ login: z.string() });

async function collectGithub(
  access: ConnectorAccess,
  since: Date,
  signal: AbortSignal,
): Promise<MorningBriefGithubData> {
  const user = await fetchJson(
    githubUserSchema,
    `${GITHUB_API_BASE}/user`,
    access.accessToken,
    signal,
  );
  const login: string | null = user.login;
  const sinceIso = since.toISOString();
  const notifications = await fetchJson(
    z.array(githubNotificationSchema),
    `${GITHUB_API_BASE}/notifications?all=true&since=${encodeURIComponent(sinceIso)}&per_page=${MAX_GITHUB_NOTIFICATIONS}`,
    access.accessToken,
    signal,
  );

  const search = async (query: string) => {
    const result = await fetchJson(
      githubSearchResponseSchema,
      `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(query)}&sort=updated&per_page=${MAX_GITHUB_SEARCH_RESULTS}`,
      access.accessToken,
      signal,
    );
    return result.items;
  };

  const sinceDate = sinceIso.slice(0, 10);
  const reviewRequests = login
    ? await search(`is:pr is:open review-requested:${login}`)
    : [];
  const myOpenPullRequests = login
    ? await search(`is:pr is:open author:${login}`)
    : [];
  const involvedItems = login
    ? await search(`involves:${login} updated:>=${sinceDate}`)
    : [];

  return {
    login,
    notifications,
    reviewRequests,
    myOpenPullRequests,
    involvedItems,
  };
}

// --- Gmail ------------------------------------------------------------------

const gmailMessageListSchema = z.object({
  messages: z
    .array(z.object({ id: z.string(), threadId: z.string() }))
    .optional(),
});

const gmailHeaderSchema = z.object({ name: z.string(), value: z.string() });

const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: z
    .object({
      headers: z.array(gmailHeaderSchema).optional(),
      parts: z
        .array(
          z.object({
            mimeType: z.string().optional(),
            body: z.object({ data: z.string().optional() }).optional(),
            filename: z.string().optional(),
          }),
        )
        .optional(),
      body: z.object({ data: z.string().optional() }).optional(),
      mimeType: z.string().optional(),
    })
    .optional(),
});

interface MorningBriefGmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labels: readonly string[];
  readonly from: string | null;
  readonly to: string | null;
  readonly subject: string | null;
  readonly date: string | null;
  readonly snippet: string | null;
  readonly body: string | null;
  readonly attachmentFilenames: readonly string[];
}

export interface MorningBriefGmailData {
  readonly emailAddress: string | null;
  readonly messages: readonly MorningBriefGmailMessage[];
}

function decodeGmailBody(data: string | undefined): string | null {
  if (!data) {
    return null;
  }
  return Buffer.from(data, "base64url").toString("utf8");
}

function gmailHeader(
  headers: readonly z.infer<typeof gmailHeaderSchema>[] | undefined,
  name: string,
): string | null {
  return (
    headers?.find((header) => {
      return header.name.toLowerCase() === name.toLowerCase();
    })?.value ?? null
  );
}

function gmailMessageBody(
  message: z.infer<typeof gmailMessageSchema>,
): string | null {
  const payload = message.payload;
  if (!payload) {
    return null;
  }
  const direct = decodeGmailBody(payload.body?.data);
  if (direct) {
    return direct;
  }
  const textPart = payload.parts?.find((part) => {
    return part.mimeType === "text/plain";
  });
  return decodeGmailBody(textPart?.body?.data);
}

async function collectGmail(
  access: ConnectorAccess,
  since: Date,
  signal: AbortSignal,
): Promise<MorningBriefGmailData> {
  const afterEpochSeconds = Math.floor(since.getTime() / 1000);
  const query = `in:anywhere -in:spam -in:trash after:${afterEpochSeconds}`;
  const list = await fetchJson(
    gmailMessageListSchema,
    `${GMAIL_API_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${MAX_GMAIL_MESSAGES}`,
    access.accessToken,
    signal,
  );

  const messages: MorningBriefGmailMessage[] = [];
  for (const item of list.messages ?? []) {
    const message = await fetchJson(
      gmailMessageSchema,
      `${GMAIL_API_BASE}/messages/${item.id}?format=full`,
      access.accessToken,
      signal,
    );
    const headers = message.payload?.headers;
    messages.push({
      id: message.id,
      threadId: message.threadId,
      labels: message.labelIds ?? [],
      from: gmailHeader(headers, "From"),
      to: gmailHeader(headers, "To"),
      subject: gmailHeader(headers, "Subject"),
      date: gmailHeader(headers, "Date"),
      snippet: message.snippet ?? null,
      body: gmailMessageBody(message),
      // Attachments stay behind: only metadata enters the brief input.
      attachmentFilenames:
        message.payload?.parts
          ?.filter((part) => {
            return part.filename !== undefined && part.filename !== "";
          })
          .map((part) => {
            return part.filename ?? "";
          }) ?? [],
    });
  }

  return { emailAddress: access.externalEmail, messages };
}

// --- Google Calendar --------------------------------------------------------

const calendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        selected: z.boolean().optional(),
        primary: z.boolean().optional(),
      }),
    )
    .optional(),
});

const calendarEventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  hangoutLink: z.string().optional(),
  htmlLink: z.string().optional(),
  start: z
    .object({ dateTime: z.string().optional(), date: z.string().optional() })
    .optional(),
  end: z
    .object({ dateTime: z.string().optional(), date: z.string().optional() })
    .optional(),
  attendees: z
    .array(
      z.object({
        email: z.string().optional(),
        displayName: z.string().optional(),
        responseStatus: z.string().optional(),
        self: z.boolean().optional(),
        organizer: z.boolean().optional(),
      }),
    )
    .optional(),
  organizer: z
    .object({ email: z.string().optional(), self: z.boolean().optional() })
    .optional(),
});

const calendarEventsSchema = z.object({
  items: z.array(calendarEventSchema).optional(),
});

type CalendarEvent = z.infer<typeof calendarEventSchema>;

export interface MorningBriefCalendarData {
  readonly events: readonly (CalendarEvent & {
    readonly calendarSummary: string | null;
  })[];
}

function isExcludedCalendar(calendarId: string): boolean {
  return (
    calendarId.includes("#holiday") ||
    calendarId.includes("#contacts") ||
    calendarId.endsWith("@group.v.calendar.google.com")
  );
}

function isDeclinedBySelf(event: CalendarEvent): boolean {
  const self = event.attendees?.find((attendee) => {
    return attendee.self === true;
  });
  return self?.responseStatus === "declined";
}

async function collectCalendar(
  access: ConnectorAccess,
  dayStart: Date,
  dayEnd: Date,
  signal: AbortSignal,
): Promise<MorningBriefCalendarData> {
  const calendarList = await fetchJson(
    calendarListSchema,
    `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`,
    access.accessToken,
    signal,
  );

  const calendars = (calendarList.items ?? []).filter((calendar) => {
    const included = calendar.selected === true || calendar.primary === true;
    return included && !isExcludedCalendar(calendar.id);
  });

  const events: (CalendarEvent & { calendarSummary: string | null })[] = [];
  for (const calendar of calendars) {
    const params = new URLSearchParams({
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(MAX_CALENDAR_EVENTS),
    });
    const response = await fetchJson(
      calendarEventsSchema,
      `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendar.id)}/events?${params.toString()}`,
      access.accessToken,
      signal,
    );
    for (const event of response.items ?? []) {
      if (event.status === "cancelled" || isDeclinedBySelf(event)) {
        continue;
      }
      events.push({ ...event, calendarSummary: calendar.summary ?? null });
    }
  }

  return { events };
}

// --- Unread vm0 chat threads ------------------------------------------------

interface MorningBriefThreadMessage {
  readonly role: string;
  readonly content: string;
  readonly at: string;
}

interface MorningBriefUnreadThread {
  readonly threadId: string;
  readonly title: string | null;
  /** Deep link into the vm0 app; ready to use as the brief item url. */
  readonly url: string;
  readonly lastMessageAt: string;
  readonly recentMessages: readonly MorningBriefThreadMessage[];
}

export interface MorningBriefChatThreadsData {
  readonly threads: readonly MorningBriefUnreadThread[];
}

/**
 * Threads whose latest message landed inside the window and past the user's
 * read watermark — typically runs that finished after the user left. The
 * Morning Brief thread itself is excluded so yesterday's brief never reports
 * on itself.
 */
async function collectUnreadChatThreads(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly since: Date;
  readonly until: Date;
  readonly excludeChatThreadId: string | null;
  readonly structuredPromptEnabled: boolean;
}): Promise<MorningBriefChatThreadsData> {
  const appUrl = env("APP_URL");
  const rows = await args.db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      lastMessageAt: chatThreads.lastMessageAt,
    })
    .from(chatThreads)
    .innerJoin(agentComposes, eq(chatThreads.agentComposeId, agentComposes.id))
    .where(
      and(
        eq(agentComposes.orgId, args.orgId),
        eq(chatThreads.userId, args.userId),
        gte(chatThreads.lastMessageAt, args.since),
        lte(chatThreads.lastMessageAt, args.until),
        or(
          isNull(chatThreads.lastReadAt),
          gt(chatThreads.lastMessageAt, chatThreads.lastReadAt),
        ),
        ...(args.excludeChatThreadId
          ? [ne(chatThreads.id, args.excludeChatThreadId)]
          : []),
      ),
    )
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(MAX_UNREAD_THREADS);

  const threads: MorningBriefUnreadThread[] = [];
  for (const row of rows) {
    const messages = await args.db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        structuredPrompt: effectiveChatMessageStructuredPrompt(),
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.chatThreadId, row.id),
          args.structuredPromptEnabled
            ? (or(
                isNotNull(chatMessages.content),
                and(
                  eq(chatMessages.role, "user"),
                  or(
                    isNotNull(chatMessages.structuredPrompt),
                    isNotNull(chatMessages.structuredPromptWithFeedback),
                  ),
                ),
              ) as SQL)
            : isNotNull(chatMessages.content),
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(MAX_THREAD_MESSAGES);
    threads.push({
      threadId: row.id,
      title: row.title,
      url: `${appUrl}/chats/${row.id}`,
      lastMessageAt: row.lastMessageAt.toISOString(),
      recentMessages: messages.reverse().flatMap((message) => {
        const content =
          args.structuredPromptEnabled &&
          message.role === "user" &&
          message.structuredPrompt
            ? projectStructuredUserMessage(message.structuredPrompt).displayText
            : message.content;
        return content === null
          ? []
          : [
              {
                role: message.role,
                content,
                at: message.createdAt.toISOString(),
              },
            ];
      }),
    });
  }

  return { threads };
}

// --- Combined input ---------------------------------------------------------

interface MorningBriefSource<T> {
  readonly ok: boolean;
  readonly error?: string;
  readonly data?: T;
}

export interface MorningBriefInput {
  readonly version: 1;
  readonly briefDate: string;
  readonly timezone: string;
  readonly generatedAt: string;
  readonly window: { readonly since: string; readonly until: string };
  readonly sources: {
    readonly github: MorningBriefSource<MorningBriefGithubData>;
    readonly gmail: MorningBriefSource<MorningBriefGmailData>;
    readonly calendar: MorningBriefSource<MorningBriefCalendarData>;
    readonly chatThreads: MorningBriefSource<MorningBriefChatThreadsData>;
  };
}

async function collectSource<T>(
  collect: () => Promise<T>,
): Promise<MorningBriefSource<T>> {
  // Partial-failure policy: the brief still goes out with the failed
  // source annotated, so one flaky upstream API never blocks the email.
  const result = await settle(collect());
  if (result.ok) {
    return { ok: true, data: result.value };
  }
  return {
    ok: false,
    error:
      result.error instanceof Error
        ? result.error.message
        : String(result.error),
  };
}

interface CollectMorningBriefInputArgs {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly briefDate: string;
  readonly timezone: string;
  readonly since: Date;
  readonly until: Date;
  readonly dayStart: Date;
  readonly dayEnd: Date;
  /** The member's Morning Brief thread; never reported as unread. */
  readonly excludeChatThreadId: string | null;
  readonly structuredPromptEnabled: boolean;
  readonly signal: AbortSignal;
}

export async function collectMorningBriefInput(
  args: CollectMorningBriefInputArgs,
): Promise<MorningBriefInput> {
  const accessFor = (connectorRef: MorningBriefConnectorRef) => {
    return resolveMorningBriefConnectorAccess({
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      connectorRef,
      signal: args.signal,
    });
  };

  const withAccess = async <T>(
    connectorRef: MorningBriefConnectorRef,
    collect: (access: ConnectorAccess) => Promise<T>,
  ): Promise<MorningBriefSource<T>> => {
    return await collectSource(async () => {
      const resolved = await accessFor(connectorRef);
      if (resolved.kind !== "ok") {
        throw new Error(resolved.message);
      }
      return await collect(resolved.access);
    });
  };

  const [github, gmail, calendar, chatThreadsSource] = await Promise.all([
    withAccess("github", (access) => {
      return collectGithub(access, args.since, args.signal);
    }),
    withAccess("gmail", (access) => {
      return collectGmail(access, args.since, args.signal);
    }),
    withAccess("google-calendar", (access) => {
      return collectCalendar(access, args.dayStart, args.dayEnd, args.signal);
    }),
    collectSource(() => {
      return collectUnreadChatThreads({
        db: args.db,
        orgId: args.orgId,
        userId: args.userId,
        since: args.since,
        until: args.until,
        excludeChatThreadId: args.excludeChatThreadId,
        structuredPromptEnabled: args.structuredPromptEnabled,
      });
    }),
  ]);

  return {
    version: 1,
    briefDate: args.briefDate,
    timezone: args.timezone,
    generatedAt: args.until.toISOString(),
    window: {
      since: args.since.toISOString(),
      until: args.until.toISOString(),
    },
    sources: { github, gmail, calendar, chatThreads: chatThreadsSource },
  };
}
