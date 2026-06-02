import { randomBytes } from "node:crypto";

import { zeroRunsMainContract } from "@vm0/api-contracts/contracts/zero-runs";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import {
  permissionGrantsToFirewallPolicies,
  resolveFirewallPolicies,
} from "@vm0/connectors/firewalls";
import {
  toFirewallPolicies,
  type FirewallPolicyValue,
  type RawPermissionPolicies,
} from "@vm0/connectors/firewall-types";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import {
  agentComposeVersions,
  agentComposes,
} from "@vm0/db/schema/agent-compose";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import type { AuthContext } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import { createAgentRun$ } from "./agent-run-create.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { loadActiveUserPermissionGrants } from "./zero-user-permission-grants.service";

type ZeroRunCreateBody = z.infer<(typeof zeroRunsMainContract.create)["body"]>;

const DISALLOWED_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "AskUserQuestion",
] as const;

const TONE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  professional:
    "Communicate in a clear, polished, and business-appropriate tone. Be thorough yet concise.",
  friendly:
    "Communicate in a warm, approachable, and conversational tone. Feel free to be casual while still being helpful.",
  direct:
    "Be brief and to the point. Skip pleasantries and filler — just deliver the information or action needed.",
  supportive:
    "Be encouraging and empathetic. Show that you're in the user's corner and proactively offer help.",
};

interface ZeroAgentRunRecord {
  readonly id: string;
  readonly orgId: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly permissionPolicies: RawPermissionPolicies | null;
  readonly unknownPermissionPolicies: Record<
    string,
    FirewallPolicyValue
  > | null;
  readonly customSkills: readonly string[];
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
  readonly content: ZeroAgentComposeContent;
}

interface UserInfo {
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly slackDisplayName?: string;
  readonly slackUserId?: string;
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
  readonly agentphoneHandle?: string;
}

interface ZeroAgentConfig {
  readonly framework?: string;
}

interface ZeroAgentComposeContent {
  readonly agent?: ZeroAgentConfig;
  readonly agents?: Record<string, ZeroAgentConfig | undefined>;
}

interface RunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

interface ZeroRunMetadata {
  readonly triggerAgentId?: string;
  readonly scheduleId?: string;
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: {
      error: {
        message,
        code: "FORBIDDEN",
      },
    },
  };
}

function apiUrl(): string {
  return env("VM0_API_URL");
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function buildAgentIdentityPrompt(agent: ZeroAgentRunRecord): string | null {
  const parts: string[] = [];

  if (agent.displayName) {
    parts.push(`Your name is ${agent.displayName}.`);
  }

  if (agent.description) {
    parts.push(`Your role: ${agent.description}`);
  }

  if (agent.sound) {
    const instruction = TONE_INSTRUCTIONS[agent.sound];
    if (instruction) {
      parts.push(instruction);
    }
  }

  return parts.length > 0 ? `# Agent Identity\n${parts.join("\n")}` : null;
}

function buildIntegrationToolsPrompt(
  triggerSource: TriggerSource,
): readonly string[] {
  const localFileContext = [
    "Local filesystem paths are only visible to the agent runtime. Users cannot open local paths directly.",
    "Localhost URLs, local dev server ports, and processes started inside the agent runtime are generally only reachable inside that runtime; users cannot rely on them as a way to view the result directly.",
    "Local dev servers are useful for agent-side verification, but they are not by themselves a user-facing deliverable.",
    "For static web artifacts, Zero provides `zero host <dir> --site <slug> [--spa]` to publish a directory containing `index.html` to a public URL that users can open.",
    "For apps or services that require a long-running backend, database, worker, external service, or framework-specific runtime, `zero host` may not be sufficient; use the project's own deployment workflow or hosting platform to make the change visible to users.",
    "A local file needs separate delivery only when it is the requested artifact or the only available user-accessible copy. If the artifact is already available through a hosted URL, email, cloud document, or another user-accessible destination, duplicate file upload is usually unnecessary unless the user asks for the file itself.",
  ];
  const localFileContextLines = localFileContext.map((line) => {
    return `- ${line}`;
  });

  switch (triggerSource) {
    case "web": {
      return [
        "- Web chat files: use `zero web download-file -h` when a web chat message includes a `[Web file]` block. `zero web upload-file -h` can share a local file back to the web chat user when file delivery is needed.",
        ...localFileContextLines,
      ];
    }
    case "slack": {
      return [
        "- Slack messaging and files: use `zero slack --help`. Normal replies are automatically sent to the originating thread, so Slack commands are for different channels/threads or explicit extra messages. Use `zero slack download-file -h` for `[Slack file]` blocks. `zero slack upload-file -h` can attach a local file to Slack when file delivery is needed. Never use SLACK_TOKEN directly — it's a user OAuth token.",
        ...localFileContextLines,
      ];
    }
    case "github": {
      return [
        "- GitHub issue/PR files: use `zero github --help`. Normal replies are automatically sent to the originating issue or pull request, so GitHub commands are for explicit extra file delivery. Use `zero github download-file -h` for `[GitHub file]` blocks. `zero github upload-file -h` can share a local file back to the issue or pull request when file delivery is needed.",
        ...localFileContextLines,
      ];
    }
    case "telegram": {
      return [
        "- Telegram messaging and files: use `zero telegram --help`. Normal replies are automatically sent to the originating chat, so Telegram commands are for different chats, topics, reply targets, or explicit extra messages. Use `zero telegram bot list` to inspect available bots, `zero telegram download-file -h` for `[Telegram file]` blocks, and `zero telegram upload-file -h` when file delivery is needed. When sending or uploading, explicitly choose the bot with `--bot-id`; if you do not know which bot to use, ask the user before sending.",
        ...localFileContextLines,
      ];
    }
    case "agentphone": {
      return [
        "- AgentPhone messaging and files: use `zero phone --help`. Normal replies are automatically sent to the originating conversation, so phone commands are for explicit extra messages or file delivery. Use `zero phone download-file -h` for `[AgentPhone file]` blocks. `zero phone upload-file -h` can share a local file when the phone channel supports the requested file delivery.",
        ...localFileContextLines,
      ];
    }
    default: {
      return [
        "- Use integration-specific messaging or file commands only when the task names an explicit delivery target or the current surface provides one.",
        ...localFileContextLines,
      ];
    }
  }
}

function buildAgentToolsPrompt(triggerSource: TriggerSource): string {
  return [
    "# Agent Tools",
    "You have access to the Zero CLI. Run commands with: `npx -p @vm0/cli zero <command>`",
    "- Discover available commands: `zero --help`.",
    "- Search agent run logs, web chat messages, or external services via connectors: `zero search --help`.",
    "- Schedule recurring tasks: `zero schedule --help`. Do NOT use /loop, cron tools (CronCreate, CronList, CronDelete), or ScheduleWakeup — they are not available.",
    "- Browser access: the runtime environment includes `agent-browser` for browser automation and inspection.",
    ...buildIntegrationToolsPrompt(triggerSource),
    "- Maps, geocoding, directions, and places: use `zero maps --help`.",
    "- Static web artifacts can be published with `zero host <dir> --site <slug> [--spa]`; run `zero host --help` for details.",
    "- Third-party services (GitHub, Slack, Notion, 100+ more) are accessed via connectors that expose environment names like `GH_TOKEN`. Find: `zero connector search <keyword>`. List connected: `zero connector list`. Inspect: `zero connector status <type>`.",
    "- Model availability and provider routing are workspace model settings, separate from connectors. Use `zero model ls` to list allowed models, `zero model switch` for model-switching guidance, and `zero model-provider ls` to inspect built-in/BYOK routing.",
    "- Credit diagnostics: use `zero doctor credit` when a run or generation fails with insufficient credits, when the user asks how to recharge, or before buying credits. It reports the org balance, tier, purchase eligibility, current user admin status, and org admins.",
    "- Buy credits: use `zero credit <credits>` to create a Stripe checkout link for org admins. It supports `--auto-recharge`, `--auto-recharge-threshold`, and `--auto-recharge-amount`; non-admins should run `zero doctor credit`.",
    "- If a connector appears unconnected, unauthenticated, missing auth/token environment names, blocked by firewall, or denied by permission policy, diagnose it with `zero doctor check-connector --help` before trying ad hoc fixes.",
    '- When the user asks to generate anything (supported generation content: image, video, presentation, voice/audio, and connector-backed text, code, document, or website), run `zero generate -h`. Use `zero generate <type>` (no --prompt) to list every provider available for that type; then run `zero generate <type> --provider built-in --prompt "..."` to execute via vm0, or `zero generate <type> --provider <connector>` to get connector skill-invocation guidance. Do not claim support for other generated content.',
    "- If you choose a Zero generation command, wait for it to finish and use its returned artifact. Do not abandon it, switch to your own generation approach, or recreate the output yourself just because generation takes a long time.",
    "- Troubleshoot permission denials: `zero doctor permission-deny --help` to identify which permission covers a blocked request.",
    "- Request permission changes: `zero doctor permission-change --help` to enable or disable a permission.",
    "- Inspect yourself: `zero whoami` for identity and permissions, `zero agent view $ZERO_AGENT_ID --instructions` for your current settings.",
    "- When the user asks to change your behavior, update your own configuration (instructions, tone, description): `zero agent edit --help`.",
    "- Manage custom skills: `zero skill --help`.",
    "- Send a direct message to the user via web chat: `zero chat message send --help`.",
    "- Report issues to the dev team: `zero developer-support --help`. Requires a two-step consent flow: (1) call without --consent-code to get a code, (2) ask the user to type it, (3) call again with --consent-code. Never submit without the user typing the consent code.",
  ].join("\n");
}

function buildCurrentUserPrompt(userInfo: UserInfo): string {
  const lines = ["# Current User Info"];
  if (userInfo.name) {
    lines.push(`Name: ${userInfo.name}`);
  }
  if (userInfo.email) {
    lines.push(`Email: ${userInfo.email}`);
  }
  lines.push(`Timezone: ${userInfo.timezone ?? "UTC"}`);
  if (userInfo.slackDisplayName) {
    lines.push(`Slack display name: ${userInfo.slackDisplayName}`);
  }
  if (userInfo.slackUserId) {
    lines.push(`Slack user ID: ${userInfo.slackUserId}`);
  }
  if (userInfo.telegramDisplayName) {
    lines.push(`Telegram display name: ${userInfo.telegramDisplayName}`);
  }
  if (userInfo.telegramUsername) {
    lines.push(`Telegram username: ${userInfo.telegramUsername}`);
  }
  if (userInfo.telegramUserId) {
    lines.push(`Telegram user ID: ${userInfo.telegramUserId}`);
  }
  if (userInfo.telegramLanguage) {
    lines.push(`Telegram language: ${userInfo.telegramLanguage}`);
  }
  if (userInfo.agentphoneHandle) {
    lines.push(`Text message handle: ${userInfo.agentphoneHandle}`);
  }
  return lines.join("\n");
}

function buildAppendSystemPrompt(args: {
  readonly agent: ZeroAgentRunRecord;
  readonly userInfo: UserInfo;
  readonly triggerSource: TriggerSource;
}): string {
  const identity = buildAgentIdentityPrompt(args.agent);
  return [
    identity,
    buildAgentToolsPrompt(args.triggerSource),
    buildCurrentUserPrompt(args.userInfo),
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

function mergeAppendSystemPrompt(
  base: string,
  appendSystemPrompt: string | undefined,
): string {
  return [base, appendSystemPrompt]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

async function inferAgentIdFromSession(
  db: Db,
  args: {
    readonly sessionId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<string | null> {
  const [session] = await db
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
      ),
    )
    .limit(1);

  return session?.agentComposeId ?? null;
}

async function loadZeroAgent(
  db: Db,
  agentId: string,
): Promise<ZeroAgentRunRecord | null> {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      orgId: zeroAgents.orgId,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      permissionPolicies: zeroAgents.permissionPolicies,
      unknownPermissionPolicies: zeroAgents.unknownPermissionPolicies,
      customSkills: zeroAgents.customSkills,
      modelProviderId: zeroAgents.modelProviderId,
      selectedModel: zeroAgents.selectedModel,
      content: agentComposeVersions.content,
    })
    .from(zeroAgents)
    .innerJoin(agentComposes, eq(agentComposes.id, zeroAgents.id))
    .innerJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentComposes.headVersionId),
    )
    .where(eq(zeroAgents.id, agentId))
    .limit(1);

  return agent
    ? {
        ...agent,
        content: agent.content as ZeroAgentComposeContent,
      }
    : null;
}

async function loadAllowedConnectorTypes(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<readonly ConnectorType[]> {
  const rows = await db
    .select({ connectorType: userConnectors.connectorType })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, args.agentId),
      ),
    );

  return rows.flatMap((row) => {
    const parsed = connectorTypeSchema.safeParse(row.connectorType);
    return parsed.success ? [parsed.data] : [];
  });
}

async function loadAllowedCustomConnectorIds(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
  },
): Promise<readonly string[]> {
  const rows = await db
    .select({ customConnectorId: userCustomConnectors.customConnectorId })
    .from(userCustomConnectors)
    .where(
      and(
        eq(userCustomConnectors.orgId, args.orgId),
        eq(userCustomConnectors.userId, args.userId),
        eq(userCustomConnectors.agentId, args.agentId),
      ),
    );

  return rows.map((row) => {
    return row.customConnectorId;
  });
}

async function resolveZeroRunPermissionPolicies(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agent: ZeroAgentRunRecord;
    readonly allowedConnectorTypes: readonly ConnectorType[];
    readonly checkedAt: Date;
  },
  signal: AbortSignal,
): Promise<ReturnType<typeof resolveFirewallPolicies>> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    args.orgId,
    args.userId,
  );
  signal.throwIfAborted();

  if (
    !isFeatureEnabled(
      FeatureSwitchKey.UserPermissionGrants,
      featureSwitchContext,
    )
  ) {
    return resolveFirewallPolicies(
      toFirewallPolicies(
        args.agent.permissionPolicies,
        args.agent.unknownPermissionPolicies,
      ),
      [...args.allowedConnectorTypes],
    );
  }

  const grants = await loadActiveUserPermissionGrants(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agent.id,
    },
    args.checkedAt,
  );
  signal.throwIfAborted();

  return resolveFirewallPolicies(permissionGrantsToFirewallPolicies(grants), [
    ...args.allowedConnectorTypes,
  ]);
}

async function loadUserInfo(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<UserInfo> {
  const [row] = await db
    .select({
      name: userCache.name,
      email: userCache.email,
      timezone: orgMembersMetadata.timezone,
    })
    .from(userCache)
    .leftJoin(
      orgMembersMetadata,
      and(
        eq(orgMembersMetadata.userId, args.userId),
        eq(orgMembersMetadata.orgId, args.orgId),
      ),
    )
    .where(eq(userCache.userId, args.userId))
    .limit(1);

  return {
    name: row?.name ?? null,
    email: row?.email ?? null,
    timezone: row?.timezone ?? null,
  };
}

async function triggerAgentIdForAuth(
  db: Db,
  auth: AuthContext & { readonly orgId: string },
): Promise<string | undefined> {
  if (auth.tokenType !== "sandbox" && auth.tokenType !== "zero") {
    return undefined;
  }

  const [parentRun] = await db
    .select({ agentComposeId: agentComposeVersions.composeId })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentRuns.agentComposeVersionId),
    )
    .where(eq(agentRuns.id, auth.runId))
    .limit(1);

  return parentRun?.agentComposeId ?? undefined;
}

function createRunBody(args: {
  readonly body: ZeroRunCreateBody;
  readonly agent: ZeroAgentRunRecord;
  readonly userInfo: UserInfo;
  readonly permissionPolicies:
    | ReturnType<typeof resolveFirewallPolicies>
    | undefined;
  readonly triggerAgentId: string | undefined;
  readonly triggerSource: TriggerSource | undefined;
  readonly appendSystemPrompt: string | undefined;
}) {
  const triggerSource =
    args.triggerSource ??
    (args.triggerAgentId ? ("agent" as const) : ("web" as const));
  const baseAppendSystemPrompt = buildAppendSystemPrompt({
    agent: args.agent,
    userInfo: args.userInfo,
    triggerSource,
  });
  return {
    prompt: args.body.prompt,
    agentComposeId: args.agent.id,
    sessionId: args.body.sessionId,
    agentComposeVersionId: args.body.agentComposeVersionId,
    conversationId: args.body.conversationId,
    checkpointId: args.body.checkpointId,
    additionalVolumes: args.body.additionalVolumes,
    debugNoMockClaude: args.body.debugNoMockClaude,
    debugNoMockCodex: args.body.debugNoMockCodex,
    captureNetworkBodies: args.body.captureNetworkBodies,
    tools: args.body.tools,
    settings: args.body.settings,
    permissionPolicies: args.permissionPolicies ?? undefined,
    triggerSource,
    appendSystemPrompt: [baseAppendSystemPrompt, args.appendSystemPrompt]
      .filter((part): part is string => {
        return Boolean(part);
      })
      .join("\n\n"),
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: { ZERO_AGENT_ID: args.agent.id },
  };
}

function createIntegrationRunBody(args: {
  readonly prompt: string;
  readonly sessionId: string | undefined;
  readonly agent: ZeroAgentRunRecord;
  readonly userInfo: UserInfo;
  readonly permissionPolicies:
    | ReturnType<typeof resolveFirewallPolicies>
    | undefined;
  readonly triggerSource: TriggerSource;
  readonly appendSystemPrompt: string | undefined;
}) {
  return {
    prompt: args.prompt,
    agentComposeId: args.agent.id,
    sessionId: args.sessionId,
    permissionPolicies: args.permissionPolicies ?? undefined,
    triggerSource: args.triggerSource,
    appendSystemPrompt: mergeAppendSystemPrompt(
      buildAppendSystemPrompt({
        agent: args.agent,
        userInfo: args.userInfo,
        triggerSource: args.triggerSource,
      }),
      args.appendSystemPrompt,
    ),
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: { ZERO_AGENT_ID: args.agent.id },
  };
}

function callbacksForTriggerAgent(triggerAgentId: string | undefined) {
  return triggerAgentId
    ? [
        {
          url: `${apiUrl()}/api/internal/callbacks/agent`,
          secret: generateCallbackSecret(),
          payload: { triggerAgentId },
        },
      ]
    : undefined;
}

export const createZeroIntegrationRun$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly sessionId?: string;
      readonly prompt: string;
      readonly appendSystemPrompt?: string;
      readonly triggerSource: TriggerSource;
      readonly callbacks?: readonly RunCallback[];
      readonly apiStartTime: number;
      readonly userInfoExtras?: Pick<
        UserInfo,
        | "slackDisplayName"
        | "slackUserId"
        | "telegramDisplayName"
        | "telegramUsername"
        | "telegramUserId"
        | "telegramLanguage"
        | "agentphoneHandle"
      >;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const agent = await loadZeroAgent(db, args.agentId);
    signal.throwIfAborted();
    if (!agent || agent.orgId !== args.orgId) {
      return notFound("Agent not found");
    }

    if (agent.visibility === "private" && agent.owner !== args.userId) {
      return forbidden("Only the private agent owner can run this agent");
    }

    const userInfo = await loadUserInfo(db, {
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    const allowedConnectorTypes = await loadAllowedConnectorTypes(db, {
      userId: args.userId,
      orgId: args.orgId,
      agentId: agent.id,
    });
    signal.throwIfAborted();
    const allowedCustomConnectorIds = await loadAllowedCustomConnectorIds(db, {
      userId: args.userId,
      orgId: args.orgId,
      agentId: agent.id,
    });
    signal.throwIfAborted();

    const agentPermissionPolicies = await resolveZeroRunPermissionPolicies(
      db,
      {
        orgId: args.orgId,
        userId: args.userId,
        agent,
        allowedConnectorTypes,
        checkedAt: new Date(args.apiStartTime),
      },
      signal,
    );

    return await set(
      createAgentRun$,
      {
        userId: args.userId,
        orgId: args.orgId,
        body: createIntegrationRunBody({
          prompt: args.prompt,
          sessionId: args.sessionId,
          agent,
          userInfo: { ...userInfo, ...args.userInfoExtras },
          permissionPolicies: agentPermissionPolicies,
          triggerSource: args.triggerSource,
          appendSystemPrompt: args.appendSystemPrompt,
        }),
        apiStartTime: args.apiStartTime,
        modelProviderId: agent.modelProviderId ?? undefined,
        selectedModelOverride: agent.selectedModel ?? undefined,
        extraEnvironment: { ZERO_AGENT_ID: agent.id },
        callbacks: args.callbacks,
        includeZeroTokenSecret: true,
        enforceVm0Credits: true,
        queueOnConcurrencyLimit: true,
        injectSkillVolumes: { customSkills: agent.customSkills },
        allowedConnectorTypes,
        allowedCustomConnectorIds,
        validateEnvironmentReferences: false,
      },
      signal,
    );
  },
);

export const createZeroRun$ = command(
  async (
    { set },
    args: {
      readonly auth: AuthContext & { readonly orgId: string };
      readonly body: ZeroRunCreateBody;
      readonly apiStartTime: number;
      readonly triggerSource?: TriggerSource;
      readonly appendSystemPrompt?: string;
      readonly userInfoExtras?: Pick<
        UserInfo,
        | "slackDisplayName"
        | "slackUserId"
        | "telegramDisplayName"
        | "telegramUsername"
        | "telegramUserId"
        | "telegramLanguage"
        | "agentphoneHandle"
      >;
      readonly callbacks?: readonly RunCallback[];
      readonly chatThreadId?: string;
      readonly modelProviderId?: string;
      readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
      readonly selectedModelOverride?: string;
      readonly zeroRunMetadata?: ZeroRunMetadata;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const agentId =
      args.body.agentId ??
      (args.body.sessionId
        ? await inferAgentIdFromSession(db, {
            sessionId: args.body.sessionId,
            userId: args.auth.userId,
            orgId: args.auth.orgId,
          })
        : null);
    signal.throwIfAborted();

    if (!agentId) {
      return args.body.sessionId
        ? notFound("Session not found")
        : badRequestMessage("agentId is required");
    }

    const agent = await loadZeroAgent(db, agentId);
    signal.throwIfAborted();
    if (!agent || agent.orgId !== args.auth.orgId) {
      return notFound("Agent not found");
    }

    if (agent.visibility === "private" && agent.owner !== args.auth.userId) {
      return forbidden("Only the private agent owner can run this agent");
    }

    const userInfo = await loadUserInfo(db, {
      userId: args.auth.userId,
      orgId: args.auth.orgId,
    });
    signal.throwIfAborted();
    const triggerAgentId = await triggerAgentIdForAuth(db, args.auth);
    signal.throwIfAborted();

    const allowedConnectorTypes = await loadAllowedConnectorTypes(db, {
      userId: args.auth.userId,
      orgId: args.auth.orgId,
      agentId: agent.id,
    });
    signal.throwIfAborted();
    const allowedCustomConnectorIds = await loadAllowedCustomConnectorIds(db, {
      userId: args.auth.userId,
      orgId: args.auth.orgId,
      agentId: agent.id,
    });
    signal.throwIfAborted();
    const agentPermissionPolicies = await resolveZeroRunPermissionPolicies(
      db,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        agent,
        allowedConnectorTypes,
        checkedAt: new Date(args.apiStartTime),
      },
      signal,
    );

    return await set(
      createAgentRun$,
      {
        userId: args.auth.userId,
        orgId: args.auth.orgId,
        body: createRunBody({
          body: args.body,
          agent,
          userInfo: { ...userInfo, ...args.userInfoExtras },
          permissionPolicies: agentPermissionPolicies,
          triggerAgentId,
          triggerSource: args.triggerSource,
          appendSystemPrompt: args.appendSystemPrompt,
        }),
        apiStartTime: args.apiStartTime,
        modelProviderId:
          args.modelProviderId ?? agent.modelProviderId ?? undefined,
        modelProviderCredentialScope: args.modelProviderCredentialScope,
        modelProviderType: args.body.modelProvider,
        selectedModelOverride:
          args.selectedModelOverride ?? agent.selectedModel ?? undefined,
        chatThreadId: args.chatThreadId,
        extraEnvironment: { ZERO_AGENT_ID: agent.id },
        callbacks: [
          ...(callbacksForTriggerAgent(triggerAgentId) ?? []),
          ...(args.callbacks ?? []),
        ],
        includeZeroTokenSecret: true,
        enforceVm0Credits: true,
        queueOnConcurrencyLimit: true,
        injectSkillVolumes: { customSkills: agent.customSkills },
        allowedConnectorTypes,
        allowedCustomConnectorIds,
        validateEnvironmentReferences: false,
        zeroRunMetadata: {
          ...args.zeroRunMetadata,
          triggerAgentId,
        },
      },
      signal,
    );
  },
);
