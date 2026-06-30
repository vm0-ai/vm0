import type {
  TeamsActor,
  TeamsInboundActivity,
} from "@vm0/api-contracts/contracts/zero-teams-bot";

interface NormalizedTeamsActivityResult {
  readonly ok: true;
  readonly activity: TeamsInboundActivity;
}

interface InvalidTeamsActivityResult {
  readonly ok: false;
  readonly error: string;
}

type TeamsActivityNormalizationResult =
  | NormalizedTeamsActivityResult
  | InvalidTeamsActivityResult;

interface ActivityBase {
  readonly activityId: string | null;
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly teamsAppId: string | null;
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly conversationType: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly channelId: string | null;
  readonly timestamp: string | null;
  readonly idempotencyKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

function readString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeActor(value: unknown): TeamsActor {
  if (!isRecord(value)) {
    return {
      id: "",
      name: null,
      aadObjectId: null,
      userPrincipalName: null,
    };
  }

  return {
    id: readString(value, "id") ?? "",
    name: readString(value, "name"),
    aadObjectId: readString(value, "aadObjectId"),
    userPrincipalName: readString(value, "userPrincipalName"),
  };
}

function normalizeActorArray(values: readonly unknown[]): TeamsActor[] {
  return values.map((value) => {
    return normalizeActor(value);
  });
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripTeamsMentions(args: {
  readonly rawText: string;
  readonly entities: readonly unknown[];
  readonly recipientId: string | null;
}): string {
  let text = args.rawText;
  for (const entity of args.entities) {
    if (!isRecord(entity) || readString(entity, "type") !== "mention") {
      continue;
    }
    const mentioned = readRecord(entity, "mentioned");
    const mentionedId = mentioned ? readString(mentioned, "id") : null;
    if (args.recipientId && mentionedId && mentionedId !== args.recipientId) {
      continue;
    }
    const mentionText = readString(entity, "text");
    if (mentionText) {
      text = text.split(mentionText).join("");
    }
  }

  return normalizeWhitespace(text.replace(/<at>[^<]+<\/at>/g, ""));
}

function idempotencyKey(
  conversationId: string,
  activityType: string,
  activityId: string | null,
  timestamp: string | null,
): string {
  const idPart = activityId ?? timestamp ?? "unknown";
  return `${conversationId}:${activityType}:${idPart}`;
}

function activityBase(
  activity: Record<string, unknown>,
): ActivityBase | InvalidTeamsActivityResult {
  const serviceUrl = readString(activity, "serviceUrl");
  const conversation = readRecord(activity, "conversation");
  const conversationId = conversation ? readString(conversation, "id") : null;
  const channelData = readRecord(activity, "channelData");
  const tenant = channelData ? readRecord(channelData, "tenant") : null;
  const tenantId = tenant ? readString(tenant, "id") : null;
  const activityType = readString(activity, "type") ?? "unknown";

  if (!serviceUrl) {
    return { ok: false, error: "Missing Teams activity serviceUrl" };
  }
  if (!conversationId) {
    return { ok: false, error: "Missing Teams conversation id" };
  }
  if (!tenantId) {
    return { ok: false, error: "Missing Teams tenant id" };
  }

  const team = channelData ? readRecord(channelData, "team") : null;
  const channel = channelData ? readRecord(channelData, "channel") : null;
  const activityId = readString(activity, "id");
  const timestamp = readString(activity, "timestamp");

  return {
    activityId,
    tenantId,
    tenantName: tenant ? readString(tenant, "name") : null,
    teamsAppId: channelData ? readString(channelData, "teamsAppId") : null,
    serviceUrl,
    conversationId,
    conversationType: conversation
      ? readString(conversation, "conversationType")
      : null,
    teamId: team ? readString(team, "id") : null,
    teamName: team ? readString(team, "name") : null,
    channelId: channel ? readString(channel, "id") : null,
    timestamp,
    idempotencyKey: idempotencyKey(
      conversationId,
      activityType,
      activityId,
      timestamp,
    ),
  };
}

function messageActivity(
  activity: Record<string, unknown>,
  base: ActivityBase,
): TeamsInboundActivity {
  const sender = normalizeActor(activity.from);
  const recipientValue = activity.recipient;
  const recipient = recipientValue ? normalizeActor(recipientValue) : null;
  const rawText = readString(activity, "text") ?? "";
  const text = stripTeamsMentions({
    rawText,
    entities: readArray(activity, "entities"),
    recipientId: recipient?.id ?? null,
  });

  return {
    ...base,
    kind: "message",
    threadId: readString(activity, "replyToId") ?? base.activityId ?? "root",
    sender,
    recipient,
    rawText,
    text,
  };
}

function conversationUpdateActivity(
  activity: Record<string, unknown>,
  base: ActivityBase,
): TeamsInboundActivity {
  const membersAdded = normalizeActorArray(readArray(activity, "membersAdded"));
  const membersRemoved = normalizeActorArray(
    readArray(activity, "membersRemoved"),
  );
  const recipient = normalizeActor(activity.recipient);
  const botRemoved =
    recipient.id.length > 0 &&
    membersRemoved.some((member) => {
      return member.id === recipient.id;
    });

  if (botRemoved) {
    return {
      ...base,
      kind: "bot_removed",
      reason: "members_removed",
      recipient,
      membersRemoved,
    };
  }

  const action =
    membersAdded.length > 0
      ? "members_added"
      : membersRemoved.length > 0
        ? "members_removed"
        : "unknown";

  return {
    ...base,
    kind: "conversation_update",
    action,
    recipient,
    membersAdded,
    membersRemoved,
  };
}

function installationUpdateActivity(
  activity: Record<string, unknown>,
  base: ActivityBase,
): TeamsInboundActivity {
  const action = readString(activity, "action");
  if (action === "remove") {
    return {
      ...base,
      kind: "bot_removed",
      reason: "installation_remove",
      recipient: activity.recipient ? normalizeActor(activity.recipient) : null,
      membersRemoved: [],
    };
  }

  return {
    ...base,
    kind: "installation_update",
    action: action === "add" ? "add" : "unknown",
    recipient: activity.recipient ? normalizeActor(activity.recipient) : null,
  };
}

export function normalizeTeamsActivity(
  input: unknown,
): TeamsActivityNormalizationResult {
  if (!isRecord(input)) {
    return { ok: false, error: "Teams activity must be a JSON object" };
  }

  const activityType = readString(input, "type");
  if (!activityType) {
    return { ok: false, error: "Missing Teams activity type" };
  }

  const base = activityBase(input);
  if ("ok" in base) {
    return base;
  }

  if (activityType === "message") {
    return { ok: true, activity: messageActivity(input, base) };
  }
  if (activityType === "conversationUpdate") {
    return { ok: true, activity: conversationUpdateActivity(input, base) };
  }
  if (activityType === "installationUpdate") {
    return { ok: true, activity: installationUpdateActivity(input, base) };
  }

  return {
    ok: true,
    activity: {
      kind: "unsupported",
      activityType,
      idempotencyKey: base.idempotencyKey,
    },
  };
}

export function readTeamsActivityServiceUrl(input: unknown): string | null {
  return isRecord(input) ? readString(input, "serviceUrl") : null;
}

export function readTeamsActivityChannelId(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }
  return readString(input, "channelId");
}
