import { Buffer } from "node:buffer";

import { OAuth2Client } from "google-auth-library";
import { command } from "ccstate";
import { and, eq, lte, or } from "drizzle-orm";
import { z } from "zod";

import { googleMeetTranscriptGeneratedEventConfigSchema } from "@vm0/api-contracts/contracts/zero-workflows";
import {
  googleWorkspaceEventSubscriptionStates,
  googleWorkspaceProcessedEvents,
} from "@vm0/db/schema/google-workspace-event";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { safeJsonParse, tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
} from "./connector-credential-runtime.service";
import {
  WorkflowEventSourceTiming,
  type WorkflowEventRunTiming,
} from "./workflow-event-source-timing.service";
import {
  buildChatOnlyWorkflowAutomationCallbacks,
  runWorkflowAutomationNow$,
  type AutomationRow,
} from "./zero-workflow-automation-run.service";
import {
  workflowAutomationAppendSystemPrompt,
  workflowAutomationPrompt,
  type WorkflowAutomationContext,
} from "./workflow-automation-context.service";
import { ensureWorkflowUserAutomationThread } from "./zero-workflow-user-automation-thread.service";

const log = logger("api:google-meet-workflow-event");

const GOOGLE_MEET_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_MEET_TOKEN";
const GOOGLE_WORKSPACE_EVENTS_API_BASE =
  "https://workspaceevents.googleapis.com/v1";
const GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE =
  "google-meet-transcript-generated";
const GOOGLE_MEET_TRANSCRIPT_FILE_GENERATED_EVENT_TYPE =
  "google.workspace.meet.transcript.v2.fileGenerated";
const GOOGLE_WORKSPACE_SUBSCRIPTION_TTL_SECONDS = 7 * 24 * 60 * 60;
const GOOGLE_WORKSPACE_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const workspaceSubscriptionSchema = z
  .object({
    name: z.string(),
    targetResource: z.string().optional(),
    eventTypes: z.array(z.string()).optional(),
    notificationEndpoint: z
      .object({
        pubsubTopic: z.string().optional(),
      })
      .passthrough()
      .optional(),
    state: z.string().optional(),
    expireTime: z.string().optional(),
    ttl: z.string().optional(),
  })
  .passthrough();

const workspaceOperationSchema = z
  .object({
    response: workspaceSubscriptionSchema.optional(),
  })
  .passthrough();

const workspaceSubscriptionsListSchema = z.object({
  subscriptions: z.array(workspaceSubscriptionSchema).optional(),
  nextPageToken: z.string().optional(),
});

const pubSubPushSchema = z.object({
  message: z
    .object({
      data: z.string().optional(),
      messageId: z.string().optional(),
      message_id: z.string().optional(),
      attributes: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  subscription: z.string().optional(),
});

const cloudEventNamedResourceSchema = z
  .object({
    name: z.string().optional(),
  })
  .passthrough();

const workspaceCloudEventDataSchema = z
  .object({
    subscription: cloudEventNamedResourceSchema
      .extend({
        expire_time: z.string().optional(),
        state: z.string().optional(),
      })
      .optional(),
    transcript: cloudEventNamedResourceSchema.optional(),
    conferenceRecord: cloudEventNamedResourceSchema
      .extend({
        transcript: cloudEventNamedResourceSchema.optional(),
      })
      .optional(),
  })
  .passthrough();

const workspaceCloudEventSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    subject: z.string().optional(),
    type: z.string(),
    time: z.string().optional(),
    specversion: z.string().optional(),
    spec_version: z.string().optional(),
    datacontenttype: z.string().optional(),
    data: workspaceCloudEventDataSchema.optional(),
  })
  .passthrough();

interface GoogleMeetAccess {
  readonly connectorId: string;
  readonly externalId: string | null;
  readonly emailAddress: string | null;
  readonly accessToken: string;
}

type GoogleMeetAccessResult =
  | { readonly kind: "ok"; readonly access: GoogleMeetAccess }
  | { readonly kind: "bad_request"; readonly message: string };

interface WorkspaceEventsFetchOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface WorkspaceEventsFetchError {
  readonly kind: "error";
  readonly status: number;
  readonly message: string;
}

type WorkspaceEventsFetchResult<T> =
  | WorkspaceEventsFetchOk<T>
  | WorkspaceEventsFetchError;

type GoogleWorkspaceSubscriptionStateRow =
  typeof googleWorkspaceEventSubscriptionStates.$inferSelect;

interface DecodedWorkspacePubSubPush {
  readonly messageId: string;
  readonly subscription: string | null;
  readonly cloudEvent: z.infer<typeof workspaceCloudEventSchema>;
}

interface GoogleMeetTranscriptEventContext {
  readonly cloudEventId: string;
  readonly cloudEventType: string;
  readonly cloudEventSource: string;
  readonly cloudEventSubject: string | null;
  readonly cloudEventTime: string | null;
  readonly subscriptionName: string;
  readonly conferenceRecordName: string | null;
  readonly transcriptName: string;
}

interface GoogleMeetEventAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly workflowTitle: string;
  readonly chatThreadId: string;
}

type GoogleWorkspaceWebhookResult =
  | {
      readonly kind: "ok";
      readonly watchStates: number;
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "config_error"; readonly message: string }
  | { readonly kind: "run_error"; readonly message: string };

type PubSubOidcClaims = {
  readonly email: string | null;
  readonly emailVerified: boolean;
};

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

function googleWorkspaceEventsTopicName():
  | { readonly kind: "ok"; readonly topicName: string }
  | { readonly kind: "bad_request"; readonly message: string } {
  const topicName = optionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME");
  return topicName
    ? { kind: "ok", topicName }
    : {
        kind: "bad_request",
        message: "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME is not configured",
      };
}

async function resolveGoogleMeetAccess(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId?: string;
  readonly signal: AbortSignal;
}): Promise<GoogleMeetAccessResult> {
  const currentTime = nowDate();
  const snapshot = await loadConnectorRuntimeSnapshot(args.db);
  args.signal.throwIfAborted();
  const loaded = await loadConnectorCredentialConnection({
    db: args.db,
    snapshot,
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: "google-meet",
    ...(args.connectorId === undefined
      ? {}
      : { connectorId: args.connectorId }),
  });
  args.signal.throwIfAborted();
  if (loaded.kind === "missing") {
    return {
      kind: "bad_request",
      message:
        "Connect Google Meet before adding a Google Meet event automation",
    };
  }
  if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Meet before using Google Meet event automations",
    };
  }
  const connection = loaded.connection;
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    connection,
    GOOGLE_MEET_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (accessTokenValueRef === null) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Meet before using Google Meet event automations",
    };
  }
  const values = await loadConnectorCredentialValues({
    connection,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
  args.signal.throwIfAborted();
  const accessToken = values.get(accessTokenValueRef);
  if (!accessToken) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Meet before using Google Meet event automations",
    };
  }
  if (!tokenNeedsRefresh(connection.tokenExpiresAt, currentTime)) {
    return {
      kind: "ok",
      access: {
        connectorId: connection.connectorId,
        externalId: connection.externalId,
        emailAddress: connection.externalEmail,
        accessToken,
      },
    };
  }
  const refreshed = await refreshConnectorCredentialAccess({
    connection,
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    runtimeEnvironmentName: GOOGLE_MEET_ACCESS_TOKEN_ENVIRONMENT_NAME,
    signal: args.signal,
    persist: { db: args.db, markNeedsReconnectOnFailure: true },
  });
  if (refreshed.kind === "configuration-unavailable") {
    return {
      kind: "bad_request",
      message: "Google OAuth client env vars are not configured",
    };
  }
  if (refreshed.kind !== "ok") {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Meet before using Google Meet event automations",
    };
  }
  return {
    kind: "ok",
    access: {
      connectorId: connection.connectorId,
      externalId: connection.externalId,
      emailAddress: connection.externalEmail,
      accessToken: refreshed.accessToken,
    },
  };
}

function workspaceEventsApiUrl(path: string): string {
  return `${GOOGLE_WORKSPACE_EVENTS_API_BASE}${path}`;
}

async function workspaceEventsFetchJson<T>(
  schema: z.ZodType<T>,
  accessToken: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<WorkspaceEventsFetchResult<T>> {
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

function workspaceOperationSubscription(
  operation: z.infer<typeof workspaceOperationSchema>,
): z.infer<typeof workspaceSubscriptionSchema> | null {
  return operation.response ?? null;
}

function eventTypesKey(eventTypes: readonly string[]): string {
  return [...eventTypes].sort().join("\n");
}

function meetTranscriptGeneratedEventTypes(): readonly string[] {
  return [GOOGLE_MEET_TRANSCRIPT_FILE_GENERATED_EVENT_TYPE];
}

function googleMeetUserTargetResource(externalId: string): string {
  return `//cloudidentity.googleapis.com/users/${externalId}`;
}

function subscriptionExpireTime(
  subscription: z.infer<typeof workspaceSubscriptionSchema>,
  currentTime: Date,
): Date {
  const parsed = subscription.expireTime
    ? new Date(subscription.expireTime)
    : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed
    : new Date(
        currentTime.getTime() +
          GOOGLE_WORKSPACE_SUBSCRIPTION_TTL_SECONDS * 1000,
      );
}

function subscriptionNeedsRenewal(
  state: GoogleWorkspaceSubscriptionStateRow,
  currentTime: Date,
): boolean {
  return (
    state.needsRepair ||
    state.expireTime.getTime() <=
      currentTime.getTime() + GOOGLE_WORKSPACE_RENEWAL_WINDOW_MS
  );
}

async function loadWorkspaceSubscriptionState(args: {
  readonly db: Db;
  readonly connectorId: string;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
  readonly signal: AbortSignal;
}): Promise<GoogleWorkspaceSubscriptionStateRow | null> {
  const [state] = await args.db
    .select()
    .from(googleWorkspaceEventSubscriptionStates)
    .where(
      and(
        eq(
          googleWorkspaceEventSubscriptionStates.connectorId,
          args.connectorId,
        ),
        eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
        eq(
          googleWorkspaceEventSubscriptionStates.targetResource,
          args.targetResource,
        ),
        eq(googleWorkspaceEventSubscriptionStates.pubsubTopic, args.topicName),
        eq(
          googleWorkspaceEventSubscriptionStates.eventTypesKey,
          eventTypesKey(args.eventTypes),
        ),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return state ?? null;
}

async function persistWorkspaceSubscriptionState(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
  readonly subscription: z.infer<typeof workspaceSubscriptionSchema>;
  readonly currentTime: Date;
  readonly signal: AbortSignal;
}): Promise<GoogleWorkspaceSubscriptionStateRow> {
  const expireTime = subscriptionExpireTime(
    args.subscription,
    args.currentTime,
  );
  const [state] = await args.db
    .insert(googleWorkspaceEventSubscriptionStates)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorId,
      provider: "google-meet",
      targetResource: args.targetResource,
      eventTypes: args.eventTypes,
      eventTypesKey: eventTypesKey(args.eventTypes),
      subscriptionName: args.subscription.name,
      pubsubTopic: args.topicName,
      state: args.subscription.state ?? null,
      expireTime,
      lastRenewedAt: args.currentTime,
      needsRepair: false,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    })
    .onConflictDoUpdate({
      target: [
        googleWorkspaceEventSubscriptionStates.connectorId,
        googleWorkspaceEventSubscriptionStates.provider,
        googleWorkspaceEventSubscriptionStates.targetResource,
        googleWorkspaceEventSubscriptionStates.pubsubTopic,
        googleWorkspaceEventSubscriptionStates.eventTypesKey,
      ],
      set: {
        subscriptionName: args.subscription.name,
        eventTypes: args.eventTypes,
        state: args.subscription.state ?? null,
        expireTime,
        lastRenewedAt: args.currentTime,
        needsRepair: false,
        updatedAt: args.currentTime,
      },
    })
    .returning();
  args.signal.throwIfAborted();
  if (!state) {
    throw new Error("Failed to persist Google Workspace subscription state");
  }
  return state;
}

async function createWorkspaceSubscription(args: {
  readonly accessToken: string;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
  readonly signal: AbortSignal;
}): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const operation = await workspaceEventsFetchJson(
    workspaceOperationSchema,
    args.accessToken,
    workspaceEventsApiUrl("/subscriptions"),
    {
      method: "POST",
      body: JSON.stringify({
        targetResource: args.targetResource,
        eventTypes: args.eventTypes,
        notificationEndpoint: {
          pubsubTopic: args.topicName,
        },
        ttl: `${GOOGLE_WORKSPACE_SUBSCRIPTION_TTL_SECONDS}s`,
      }),
    },
    args.signal,
  );
  args.signal.throwIfAborted();
  if (operation.kind !== "ok") {
    return operation;
  }
  const subscription = workspaceOperationSubscription(operation.value);
  return subscription
    ? { kind: "ok", value: subscription }
    : {
        kind: "error",
        status: 502,
        message: "Workspace Events create response omitted subscription",
      };
}

async function renewWorkspaceSubscription(args: {
  readonly accessToken: string;
  readonly subscriptionName: string;
  readonly signal: AbortSignal;
}): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const url = new URL(workspaceEventsApiUrl(`/${args.subscriptionName}`));
  url.searchParams.set("updateMask", "ttl");
  const operation = await workspaceEventsFetchJson(
    workspaceOperationSchema,
    args.accessToken,
    url.toString(),
    {
      method: "PATCH",
      body: JSON.stringify({
        name: args.subscriptionName,
        ttl: `${GOOGLE_WORKSPACE_SUBSCRIPTION_TTL_SECONDS}s`,
      }),
    },
    args.signal,
  );
  args.signal.throwIfAborted();
  if (operation.kind !== "ok") {
    return operation;
  }
  const subscription = workspaceOperationSubscription(operation.value);
  return subscription
    ? { kind: "ok", value: subscription }
    : {
        kind: "error",
        status: 502,
        message: "Workspace Events renew response omitted subscription",
      };
}

async function reactivateWorkspaceSubscription(args: {
  readonly accessToken: string;
  readonly subscriptionName: string;
  readonly signal: AbortSignal;
}): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const operation = await workspaceEventsFetchJson(
    workspaceOperationSchema,
    args.accessToken,
    workspaceEventsApiUrl(`/${args.subscriptionName}:reactivate`),
    { method: "POST", body: JSON.stringify({}) },
    args.signal,
  );
  args.signal.throwIfAborted();
  if (operation.kind !== "ok") {
    return operation;
  }
  const subscription = workspaceOperationSubscription(operation.value);
  return subscription
    ? { kind: "ok", value: subscription }
    : {
        kind: "error",
        status: 502,
        message: "Workspace Events reactivate response omitted subscription",
      };
}

async function listWorkspaceSubscriptions(args: {
  readonly accessToken: string;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly signal: AbortSignal;
}): Promise<
  WorkspaceEventsFetchResult<
    readonly z.infer<typeof workspaceSubscriptionSchema>[]
  >
> {
  const subscriptions: z.infer<typeof workspaceSubscriptionSchema>[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(workspaceEventsApiUrl("/subscriptions"));
    url.searchParams.set("pageSize", "100");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const filter = `${args.eventTypes
      .map((eventType) => {
        return `event_types:"${eventType}"`;
      })
      .join(" OR ")} AND target_resource="${args.targetResource}"`;
    url.searchParams.set("filter", filter);

    const result = await workspaceEventsFetchJson(
      workspaceSubscriptionsListSchema,
      args.accessToken,
      url.toString(),
      { method: "GET" },
      args.signal,
    );
    args.signal.throwIfAborted();
    if (result.kind !== "ok") {
      return result;
    }
    subscriptions.push(...(result.value.subscriptions ?? []));
    pageToken = result.value.nextPageToken ?? null;
  } while (pageToken);

  return { kind: "ok", value: subscriptions };
}

function workspaceSubscriptionMatches(args: {
  readonly subscription: z.infer<typeof workspaceSubscriptionSchema>;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
}): boolean {
  const eventTypes = new Set(args.subscription.eventTypes ?? []);
  return (
    args.subscription.targetResource === args.targetResource &&
    args.subscription.notificationEndpoint?.pubsubTopic === args.topicName &&
    args.eventTypes.every((eventType) => {
      return eventTypes.has(eventType);
    })
  );
}

async function adoptExistingWorkspaceSubscription(args: {
  readonly accessToken: string;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
  readonly signal: AbortSignal;
}): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const list = await listWorkspaceSubscriptions(args);
  args.signal.throwIfAborted();
  if (list.kind !== "ok") {
    return list;
  }
  const subscription = list.value.find((candidate) => {
    return workspaceSubscriptionMatches({
      subscription: candidate,
      targetResource: args.targetResource,
      eventTypes: args.eventTypes,
      topicName: args.topicName,
    });
  });
  return subscription
    ? { kind: "ok", value: subscription }
    : {
        kind: "error",
        status: 409,
        message:
          "Workspace Events subscription already exists for this Google Meet account but does not target the configured Pub/Sub topic",
      };
}

async function createOrAdoptWorkspaceSubscription(args: {
  readonly accessToken: string;
  readonly targetResource: string;
  readonly eventTypes: readonly string[];
  readonly topicName: string;
  readonly signal: AbortSignal;
}): Promise<
  WorkspaceEventsFetchResult<z.infer<typeof workspaceSubscriptionSchema>>
> {
  const created = await createWorkspaceSubscription(args);
  args.signal.throwIfAborted();
  if (created.kind === "ok") {
    return created;
  }
  if (created.status !== 409) {
    return created;
  }
  return await adoptExistingWorkspaceSubscription(args);
}

export async function ensureGoogleMeetTranscriptGeneratedSubscriptionForUser(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly kind: "ok" }
  | { readonly kind: "bad_request"; readonly message: string }
> {
  const topicResult = googleWorkspaceEventsTopicName();
  if (topicResult.kind !== "ok") {
    return topicResult;
  }
  const accessResult = await resolveGoogleMeetAccess(args);
  args.signal.throwIfAborted();
  if (accessResult.kind !== "ok") {
    return accessResult;
  }
  if (!accessResult.access.externalId) {
    return {
      kind: "bad_request",
      message:
        "Reconnect Google Meet before using Google Meet event automations; the connected account is missing a Google user id",
    };
  }

  const eventTypes = meetTranscriptGeneratedEventTypes();
  const targetResource = googleMeetUserTargetResource(
    accessResult.access.externalId,
  );
  const existing = await loadWorkspaceSubscriptionState({
    db: args.db,
    connectorId: accessResult.access.connectorId,
    targetResource,
    eventTypes,
    topicName: topicResult.topicName,
    signal: args.signal,
  });
  const currentTime = nowDate();
  if (existing && !subscriptionNeedsRenewal(existing, currentTime)) {
    return { kind: "ok" };
  }

  let subscription: WorkspaceEventsFetchResult<
    z.infer<typeof workspaceSubscriptionSchema>
  >;
  if (existing) {
    if (existing.needsRepair) {
      await reactivateWorkspaceSubscription({
        accessToken: accessResult.access.accessToken,
        subscriptionName: existing.subscriptionName,
        signal: args.signal,
      });
      args.signal.throwIfAborted();
    }
    subscription = await renewWorkspaceSubscription({
      accessToken: accessResult.access.accessToken,
      subscriptionName: existing.subscriptionName,
      signal: args.signal,
    });
    args.signal.throwIfAborted();
    if (subscription.kind !== "ok" && subscription.status === 404) {
      subscription = await createOrAdoptWorkspaceSubscription({
        accessToken: accessResult.access.accessToken,
        targetResource,
        eventTypes,
        topicName: topicResult.topicName,
        signal: args.signal,
      });
    }
  } else {
    subscription = await createOrAdoptWorkspaceSubscription({
      accessToken: accessResult.access.accessToken,
      targetResource,
      eventTypes,
      topicName: topicResult.topicName,
      signal: args.signal,
    });
  }

  args.signal.throwIfAborted();
  if (subscription.kind !== "ok") {
    return {
      kind: "bad_request",
      message: `Failed to ensure Google Meet Workspace Events subscription: ${subscription.message}`,
    };
  }

  await persistWorkspaceSubscriptionState({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    connectorId: accessResult.access.connectorId,
    targetResource,
    eventTypes,
    topicName: topicResult.topicName,
    subscription: subscription.value,
    currentTime,
    signal: args.signal,
  });
  return { kind: "ok" };
}

async function defaultPubSubOidcVerifier(
  token: string,
  audience: string,
  signal: AbortSignal,
): Promise<PubSubOidcClaims> {
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({
    idToken: token,
    audience,
  });
  signal.throwIfAborted();
  const payload = ticket.getPayload();
  return {
    email: payload?.email ?? null,
    emailVerified: payload?.email_verified === true,
  };
}

async function verifyGoogleWorkspacePubSubOidc(args: {
  readonly authorization: string | null;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly kind: "ok" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "config_error"; readonly message: string }
> {
  const audience = optionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE");
  const expectedEmail = optionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
  );
  if (!audience || !expectedEmail) {
    return {
      kind: "config_error",
      message:
        "Google Workspace Events Pub/Sub push OIDC env vars are not configured",
    };
  }

  if (!args.authorization?.startsWith("Bearer ")) {
    return { kind: "unauthorized" };
  }

  const token = args.authorization.slice("Bearer ".length);
  const claims = await tapError(
    defaultPubSubOidcVerifier(token, audience, args.signal),
  );
  args.signal.throwIfAborted();
  if (!claims) {
    return { kind: "unauthorized" };
  }

  return claims.email === expectedEmail && claims.emailVerified
    ? { kind: "ok" }
    : { kind: "unauthorized" };
}

function decodeBase64Json(input: string | undefined): unknown {
  if (!input) {
    return undefined;
  }
  const decoded = Buffer.from(input, "base64").toString("utf8");
  return safeJsonParse(decoded);
}

function cloudEventFromPubSubPush(
  rawPush: z.infer<typeof pubSubPushSchema>,
):
  | DecodedWorkspacePubSubPush
  | { readonly kind: "bad_request"; readonly message: string } {
  const messageId = rawPush.message.messageId ?? rawPush.message.message_id;
  if (!messageId) {
    return {
      kind: "bad_request",
      message: "Invalid Google Workspace Events Pub/Sub message id",
    };
  }

  const attributes = rawPush.message.attributes ?? {};
  const decodedData = decodeBase64Json(rawPush.message.data);
  const attributeType = attributes["ce-type"];
  if (attributeType) {
    const parsed = workspaceCloudEventSchema.safeParse({
      id: attributes["ce-id"],
      source: attributes["ce-source"],
      subject: attributes["ce-subject"],
      type: attributeType,
      time: attributes["ce-time"],
      specversion: attributes["ce-specversion"],
      datacontenttype: attributes["content-type"],
      data: decodedData,
    });
    if (!parsed.success) {
      return {
        kind: "bad_request",
        message: "Invalid Google Workspace Events CloudEvent attributes",
      };
    }
    return {
      messageId,
      subscription: rawPush.subscription ?? null,
      cloudEvent: parsed.data,
    };
  }

  const parsed = workspaceCloudEventSchema.safeParse(decodedData);
  if (!parsed.success) {
    return {
      kind: "bad_request",
      message: "Invalid Google Workspace Events CloudEvent payload",
    };
  }
  return {
    messageId,
    subscription: rawPush.subscription ?? null,
    cloudEvent: parsed.data,
  };
}

function decodeWorkspacePubSubPush(
  rawBody: string,
):
  | DecodedWorkspacePubSubPush
  | { readonly kind: "bad_request"; readonly message: string } {
  const rawPush = safeJsonParse(rawBody);
  if (rawPush === undefined) {
    return {
      kind: "bad_request",
      message: "Invalid Google Workspace Events Pub/Sub push payload",
    };
  }
  const push = pubSubPushSchema.safeParse(rawPush);
  if (!push.success) {
    return {
      kind: "bad_request",
      message: "Invalid Google Workspace Events Pub/Sub push payload",
    };
  }
  return cloudEventFromPubSubPush(push.data);
}

function subscriptionNameFromSource(source: string): string | null {
  const match = source.match(
    /^\/\/workspaceevents\.googleapis\.com\/(subscriptions\/[^/]+)$/,
  );
  return match?.[1] ?? null;
}

function dataRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function nestedName(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).name === "string"
    ? ((value as Record<string, unknown>).name as string)
    : null;
}

function transcriptNameFromCloudEventData(data: unknown): string | null {
  const root = dataRecord(data);
  const transcript = nestedName(root, "transcript");
  if (transcript) {
    return transcript;
  }
  const conferenceRecord = dataRecord(root.conferenceRecord);
  return nestedName(conferenceRecord, "transcript");
}

function subscriptionNameFromCloudEvent(
  cloudEvent: z.infer<typeof workspaceCloudEventSchema>,
): string | null {
  const sourceSubscription = subscriptionNameFromSource(cloudEvent.source);
  if (sourceSubscription) {
    return sourceSubscription;
  }
  const data = dataRecord(cloudEvent.data);
  const subscription = nestedName(data, "subscription");
  return subscription;
}

function conferenceRecordNameFromTranscriptName(
  transcriptName: string,
): string | null {
  const marker = "/transcripts/";
  const index = transcriptName.indexOf(marker);
  return index > 0 ? transcriptName.slice(0, index) : null;
}

function googleMeetTranscriptEventContext(
  decoded: DecodedWorkspacePubSubPush,
):
  | { readonly kind: "ok"; readonly context: GoogleMeetTranscriptEventContext }
  | { readonly kind: "bad_request"; readonly message: string }
  | { readonly kind: "ignored" } {
  const { cloudEvent } = decoded;
  if (cloudEvent.type !== GOOGLE_MEET_TRANSCRIPT_FILE_GENERATED_EVENT_TYPE) {
    return { kind: "ignored" };
  }
  const subscriptionName = subscriptionNameFromCloudEvent(cloudEvent);
  if (!subscriptionName) {
    return {
      kind: "bad_request",
      message: "Google Workspace Events CloudEvent missing subscription source",
    };
  }
  const transcriptName = transcriptNameFromCloudEventData(cloudEvent.data);
  if (!transcriptName) {
    return {
      kind: "bad_request",
      message: "Google Meet transcript event missing transcript resource name",
    };
  }
  return {
    kind: "ok",
    context: {
      cloudEventId: cloudEvent.id,
      cloudEventType: cloudEvent.type,
      cloudEventSource: cloudEvent.source,
      cloudEventSubject: cloudEvent.subject ?? null,
      cloudEventTime: cloudEvent.time ?? null,
      subscriptionName,
      transcriptName,
      conferenceRecordName:
        conferenceRecordNameFromTranscriptName(transcriptName),
    },
  };
}

async function loadWorkspaceSubscriptionStateByName(args: {
  readonly db: Db;
  readonly subscriptionName: string;
  readonly signal: AbortSignal;
}): Promise<GoogleWorkspaceSubscriptionStateRow | null> {
  const [state] = await args.db
    .select()
    .from(googleWorkspaceEventSubscriptionStates)
    .where(
      eq(
        googleWorkspaceEventSubscriptionStates.subscriptionName,
        args.subscriptionName,
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return state ?? null;
}

async function handleWorkspaceLifecycleEvent(args: {
  readonly db: Db;
  readonly decoded: DecodedWorkspacePubSubPush;
  readonly signal: AbortSignal;
}): Promise<void> {
  const subscriptionName = subscriptionNameFromCloudEvent(
    args.decoded.cloudEvent,
  );
  if (!subscriptionName) {
    return;
  }
  const currentTime = nowDate();
  const data = dataRecord(args.decoded.cloudEvent.data);
  const subscription = dataRecord(data.subscription);
  const expireTime =
    typeof subscription.expire_time === "string"
      ? new Date(subscription.expire_time)
      : null;
  const update: {
    state?: string;
    expireTime?: Date;
    needsRepair: boolean;
    updatedAt: Date;
  } = {
    needsRepair:
      args.decoded.cloudEvent.type !==
      "google.workspace.events.subscription.v1.expirationReminder",
    updatedAt: currentTime,
  };
  if (
    args.decoded.cloudEvent.type ===
    "google.workspace.events.subscription.v1.suspended"
  ) {
    update.state = "SUSPENDED";
  } else if (
    args.decoded.cloudEvent.type ===
    "google.workspace.events.subscription.v1.expired"
  ) {
    update.state = "DELETED";
  }
  if (expireTime && !Number.isNaN(expireTime.getTime())) {
    update.expireTime = expireTime;
  }

  await args.db
    .update(googleWorkspaceEventSubscriptionStates)
    .set(update)
    .where(
      eq(
        googleWorkspaceEventSubscriptionStates.subscriptionName,
        subscriptionName,
      ),
    );
  args.signal.throwIfAborted();
}

async function loadGoogleMeetEventAutomations(args: {
  readonly db: Db;
  readonly state: GoogleWorkspaceSubscriptionStateRow;
  readonly signal: AbortSignal;
}): Promise<GoogleMeetEventAutomationRow[]> {
  const automationRows = await args.db
    .select({
      automation: zeroWorkflowAutomations,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowAutomations.workflowId, zeroWorkflows.id),
    )
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, zeroWorkflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          zeroWorkflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          zeroWorkflowAutomations.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, args.state.orgId),
        eq(zeroWorkflowAutomations.ownerUserId, args.state.userId),
        eq(zeroWorkflowAutomations.enabled, true),
        eq(zeroWorkflowAutomations.kind, "event"),
        eq(
          zeroWorkflowAutomations.eventType,
          GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
        ),
      ),
    );
  args.signal.throwIfAborted();

  const currentTime = nowDate();
  const automations: GoogleMeetEventAutomationRow[] = [];
  for (const row of automationRows) {
    const config = googleMeetTranscriptGeneratedEventConfigSchema.safeParse(
      row.automation.eventConfig,
    );
    if (!config.success || config.data.scope.type !== "organizer_user") {
      continue;
    }
    const chatThreadId =
      row.chatThreadId ??
      (await args.db.transaction(async (tx) => {
        return await ensureWorkflowUserAutomationThread(tx, {
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
          workflowId: row.automation.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
    args.signal.throwIfAborted();
    automations.push({
      automation: row.automation,
      agentId: row.agentId,
      workflowName: row.workflowName,
      workflowTitle: row.workflowDisplayName ?? row.workflowName,
      chatThreadId,
    });
  }
  return automations;
}

async function insertWorkspaceProcessedEvent(args: {
  readonly db: Db;
  readonly state: GoogleWorkspaceSubscriptionStateRow;
  readonly automation: GoogleMeetEventAutomationRow;
  readonly decoded: DecodedWorkspacePubSubPush;
  readonly event: GoogleMeetTranscriptEventContext;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const [processed] = await args.db
    .insert(googleWorkspaceProcessedEvents)
    .values({
      subscriptionStateId: args.state.id,
      automationId: args.automation.automation.id,
      pubsubMessageId: args.decoded.messageId,
      cloudEventId: args.event.cloudEventId,
      cloudEventType: args.event.cloudEventType,
      conferenceRecordName: args.event.conferenceRecordName,
      transcriptName: args.event.transcriptName,
      createdAt: nowDate(),
    })
    .onConflictDoNothing()
    .returning({ id: googleWorkspaceProcessedEvents.id });
  args.signal.throwIfAborted();
  return processed?.id ?? null;
}

function buildGoogleMeetWorkflowAutomationBrief(
  event: GoogleMeetTranscriptEventContext,
): string {
  return `Google Meet transcript ready: ${event.transcriptName}`;
}

function googleMeetTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly event: GoogleMeetTranscriptEventContext;
}): WorkflowAutomationContext {
  return {
    workflowName: args.workflowName,
    eventType: "google-meet-transcript-generated",
    trigger: `Google Meet generated transcript ${args.event.transcriptName} for a meeting organized by the connected account (cloud event ${args.event.cloudEventId}).`,
    notes: [
      "Not included below: the transcript text. Connected Google Meet tools return transcript metadata and entries.",
    ],
    event: {
      automationId: args.automationId,
      eventType: GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
      googleWorkspaceEventType: args.event.cloudEventType,
      cloudEventId: args.event.cloudEventId,
      cloudEventSource: args.event.cloudEventSource,
      cloudEventSubject: args.event.cloudEventSubject,
      cloudEventTime: args.event.cloudEventTime,
      subscriptionName: args.event.subscriptionName,
      conferenceRecordName: args.event.conferenceRecordName,
      transcriptName: args.event.transcriptName,
    },
  };
}

async function dispatchGoogleMeetTranscriptEventForState(args: {
  readonly db: Db;
  readonly state: GoogleWorkspaceSubscriptionStateRow;
  readonly decoded: DecodedWorkspacePubSubPush;
  readonly event: GoogleMeetTranscriptEventContext;
  readonly startRun: (args: {
    readonly automation: GoogleMeetEventAutomationRow;
    readonly event: GoogleMeetTranscriptEventContext;
    readonly timing: WorkflowEventRunTiming;
  }) => Promise<"ok" | "error">;
  readonly sourceTiming: WorkflowEventSourceTiming;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly kind: "ok";
      readonly dispatched: number;
      readonly duplicates: number;
    }
  | { readonly kind: "run_error"; readonly message: string }
> {
  const automations = await args.sourceTiming.measure(
    "api_dispatch_pre_create_zero_workflow_event_load_automations",
    async () => {
      return await loadGoogleMeetEventAutomations({
        db: args.db,
        state: args.state,
        signal: args.signal,
      });
    },
  );
  let dispatched = 0;
  let duplicates = 0;

  for (const automation of automations) {
    const runTiming = args.sourceTiming.createRunTiming();
    const processedId = await runTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_record_processed_event",
      async () => {
        return await insertWorkspaceProcessedEvent({
          db: args.db,
          state: args.state,
          automation,
          decoded: args.decoded,
          event: args.event,
          signal: args.signal,
        });
      },
    );
    if (!processedId) {
      duplicates++;
      continue;
    }

    const started = await args.startRun({
      automation,
      event: args.event,
      timing: runTiming,
    });
    args.signal.throwIfAborted();
    if (started !== "ok") {
      await args.db
        .delete(googleWorkspaceProcessedEvents)
        .where(eq(googleWorkspaceProcessedEvents.id, processedId));
      args.signal.throwIfAborted();
      return {
        kind: "run_error",
        message: "Failed to start Google Meet transcript workflow run",
      };
    }
    dispatched++;
  }

  return { kind: "ok", dispatched, duplicates };
}

export const dispatchGoogleWorkspaceEventsPubSubPush$ = command(
  async (
    { set },
    args: {
      readonly authorization: string | null;
      readonly rawBody: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<GoogleWorkspaceWebhookResult> => {
    const auth = await verifyGoogleWorkspacePubSubOidc({
      authorization: args.authorization,
      signal,
    });
    signal.throwIfAborted();
    if (auth.kind !== "ok") {
      return auth;
    }

    const decoded = decodeWorkspacePubSubPush(args.rawBody);
    if ("kind" in decoded) {
      return decoded;
    }

    const db = set(writeDb$);
    if (
      decoded.cloudEvent.type.startsWith(
        "google.workspace.events.subscription.v1.",
      )
    ) {
      await handleWorkspaceLifecycleEvent({ db, decoded, signal });
      return { kind: "ok", watchStates: 0, dispatched: 0, duplicates: 0 };
    }

    const event = googleMeetTranscriptEventContext(decoded);
    if (event.kind === "ignored") {
      return { kind: "ok", watchStates: 0, dispatched: 0, duplicates: 0 };
    }
    if (event.kind !== "ok") {
      return event;
    }

    const sourceTiming = new WorkflowEventSourceTiming(
      "google_meet",
      args.apiStartTime,
    );
    const state = await sourceTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_load_source_state",
      async () => {
        return await loadWorkspaceSubscriptionStateByName({
          db,
          subscriptionName: event.context.subscriptionName,
          signal,
        });
      },
    );
    signal.throwIfAborted();
    if (!state || state.provider !== "google-meet") {
      return { kind: "ok", watchStates: 0, dispatched: 0, duplicates: 0 };
    }

    const result = await dispatchGoogleMeetTranscriptEventForState({
      db,
      state,
      decoded,
      event: event.context,
      sourceTiming,
      startRun: async ({ automation, event, timing }) => {
        const runInput = await timing.measure(
          "api_dispatch_pre_create_zero_workflow_event_build_run_input",
          () => {
            const context = googleMeetTriggerContext({
              workflowName: automation.workflowName,
              automationId: automation.automation.id,
              event,
            });
            return {
              context,
              prompt: workflowAutomationPrompt(context),
              appendSystemPrompt: workflowAutomationAppendSystemPrompt(context),
              triggerBrief: buildGoogleMeetWorkflowAutomationBrief(event),
              callbacks: buildChatOnlyWorkflowAutomationCallbacks(
                automation.chatThreadId,
                automation.agentId,
              ),
            };
          },
        );
        const result = await set(
          runWorkflowAutomationNow$,
          {
            due: {
              automation: automation.automation,
              agentId: automation.agentId,
              workflowName: automation.workflowName,
              chatThreadId: automation.chatThreadId,
            },
            automationContext: runInput.context,
            apiStartTime: args.apiStartTime,
            triggerSource: "workflow-event",
            prompt: runInput.prompt,
            appendSystemPrompt: runInput.appendSystemPrompt,
            triggerBrief: runInput.triggerBrief,
            callbacks: runInput.callbacks,
            activePreviousRunPolicy: "allow",
            recordLastRunId: false,
            recordLastRunAt: true,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            timing: timing.collectorForRunStart(),
          },
          signal,
        );
        signal.throwIfAborted();
        return result.kind === "ok" || result.kind === "enqueued"
          ? "ok"
          : "error";
      },
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

async function repairEnabledGoogleMeetAutomations(args: {
  readonly db: Db;
  readonly signal: AbortSignal;
}): Promise<{ readonly repaired: number; readonly failed: number }> {
  const automationRows = await args.db
    .select({
      orgId: zeroWorkflowAutomations.orgId,
      userId: zeroWorkflowAutomations.ownerUserId,
    })
    .from(zeroWorkflowAutomations)
    .where(
      and(
        eq(zeroWorkflowAutomations.enabled, true),
        eq(zeroWorkflowAutomations.kind, "event"),
        eq(
          zeroWorkflowAutomations.eventType,
          GOOGLE_MEET_TRANSCRIPT_GENERATED_EVENT_TYPE,
        ),
      ),
    );
  args.signal.throwIfAborted();

  const seen = new Set<string>();
  let repaired = 0;
  let failed = 0;
  for (const automation of automationRows) {
    const key = `${automation.orgId}\n${automation.userId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const ensured =
      await ensureGoogleMeetTranscriptGeneratedSubscriptionForUser({
        db: args.db,
        orgId: automation.orgId,
        userId: automation.userId,
        signal: args.signal,
      });
    args.signal.throwIfAborted();
    if (ensured.kind === "ok") {
      repaired++;
    } else {
      failed++;
      log.warn("Failed to repair Google Meet Workspace Events subscription", {
        orgId: automation.orgId,
        userId: automation.userId,
        message: ensured.message,
      });
    }
  }

  return { repaired, failed };
}

export const renewGoogleWorkspaceEventSubscriptions$ = command(
  async ({ set }, signal: AbortSignal) => {
    const topicResult = googleWorkspaceEventsTopicName();
    if (topicResult.kind !== "ok") {
      return { renewed: 0, repaired: 0, failed: 0 };
    }

    const db = set(writeDb$);
    const currentTime = nowDate();
    const renewBefore = new Date(
      currentTime.getTime() + GOOGLE_WORKSPACE_RENEWAL_WINDOW_MS,
    );
    const states = await db
      .select()
      .from(googleWorkspaceEventSubscriptionStates)
      .where(
        and(
          eq(googleWorkspaceEventSubscriptionStates.provider, "google-meet"),
          eq(
            googleWorkspaceEventSubscriptionStates.pubsubTopic,
            topicResult.topicName,
          ),
          or(
            eq(googleWorkspaceEventSubscriptionStates.needsRepair, true),
            lte(googleWorkspaceEventSubscriptionStates.expireTime, renewBefore),
          ),
        ),
      );
    signal.throwIfAborted();

    let renewed = 0;
    let failed = 0;
    for (const state of states) {
      const access = await resolveGoogleMeetAccess({
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

      let subscription: WorkspaceEventsFetchResult<
        z.infer<typeof workspaceSubscriptionSchema>
      >;
      if (state.needsRepair) {
        await reactivateWorkspaceSubscription({
          accessToken: access.access.accessToken,
          subscriptionName: state.subscriptionName,
          signal,
        });
        signal.throwIfAborted();
      }
      subscription = await renewWorkspaceSubscription({
        accessToken: access.access.accessToken,
        subscriptionName: state.subscriptionName,
        signal,
      });
      signal.throwIfAborted();

      if (subscription.kind !== "ok" && subscription.status === 404) {
        subscription = await createOrAdoptWorkspaceSubscription({
          accessToken: access.access.accessToken,
          targetResource: state.targetResource,
          eventTypes: state.eventTypes,
          topicName: state.pubsubTopic,
          signal,
        });
      }

      if (subscription.kind !== "ok") {
        failed++;
        continue;
      }
      await persistWorkspaceSubscriptionState({
        db,
        orgId: state.orgId,
        userId: state.userId,
        connectorId: state.connectorId,
        targetResource: state.targetResource,
        eventTypes: state.eventTypes,
        topicName: state.pubsubTopic,
        subscription: subscription.value,
        currentTime,
        signal,
      });
      signal.throwIfAborted();
      renewed++;
    }

    const repair = await repairEnabledGoogleMeetAutomations({ db, signal });
    return {
      renewed,
      repaired: repair.repaired,
      failed: failed + repair.failed,
    };
  },
);
