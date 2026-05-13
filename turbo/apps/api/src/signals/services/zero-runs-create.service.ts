import { randomBytes } from "node:crypto";

import { zeroRunsMainContract } from "@vm0/api-contracts/contracts/zero-runs";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import {
  connectorTypeSchema,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { resolveFirewallPolicies } from "@vm0/connectors/firewalls";
import {
  toFirewallPolicies,
  type FirewallPolicyValue,
  type RawPermissionPolicies,
} from "@vm0/connectors/firewall-types";
import { isSupportedFramework, type SupportedFramework } from "@vm0/core";
import { resolveSkillRef, parseGitHubTreeUrl } from "@vm0/core/github-url";
import {
  getCustomSkillStorageName,
  getSkillStorageName,
} from "@vm0/core/storage-names";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
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
    "Be brief and to the point. Skip pleasantries and filler -- just deliver the information or action needed.",
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
}

interface ZeroAgentConfig {
  readonly framework?: string;
}

interface ZeroAgentComposeContent {
  readonly agent?: ZeroAgentConfig;
  readonly agents?: Record<string, ZeroAgentConfig | undefined>;
}

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
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

function firstAgent(content: ZeroAgentComposeContent): ZeroAgentConfig | null {
  if (content.agent) {
    return content.agent;
  }

  const firstKey = Object.keys(content.agents ?? {})[0];
  if (!firstKey) {
    return null;
  }
  return content.agents?.[firstKey] ?? null;
}

function resolveAgentFramework(
  content: ZeroAgentComposeContent,
): SupportedFramework | null {
  const framework = firstAgent(content)?.framework;
  return isSupportedFramework(framework) ? framework : null;
}

function resolveFrameworkSkillsMountPath(
  framework: SupportedFramework,
): string {
  return framework === "codex"
    ? "/home/user/.codex/skills"
    : "/home/user/.claude/skills";
}

function buildSkillMountPath(
  framework: SupportedFramework,
  skillName: string,
): string {
  return `${resolveFrameworkSkillsMountPath(framework)}/${skillName}`;
}

function buildSystemSkillVolumes(
  connectorTypes: readonly ConnectorType[],
  framework: SupportedFramework,
): readonly AdditionalVolume[] {
  const allSkillNames = [...new Set([...SEED_SKILLS, ...connectorTypes])];
  return allSkillNames.flatMap((skillName) => {
    const url = resolveSkillRef(skillName);
    const parsed = parseGitHubTreeUrl(url);
    if (!parsed) {
      return [];
    }
    return [
      {
        name: getSkillStorageName(parsed.fullPath),
        mountPath: buildSkillMountPath(framework, parsed.skillName),
        system: true,
      },
    ];
  });
}

function buildCustomSkillVolumes(
  customSkills: readonly string[],
  framework: SupportedFramework,
): readonly AdditionalVolume[] {
  return customSkills.map((name) => {
    return {
      name: getCustomSkillStorageName(name),
      mountPath: buildSkillMountPath(framework, name),
    };
  });
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

function buildAgentToolsPrompt(): string {
  return [
    "# Agent Tools",
    "You have access to the Zero CLI. Run commands with: `npx -p @vm0/cli zero <command>`",
    "- Discover available commands: `zero --help`.",
    "- Search agent run logs, web chat messages, or external services via connectors: `zero search --help`.",
    "- Schedule recurring tasks: `zero schedule --help`. Do NOT use /loop, cron tools (CronCreate, CronList, CronDelete), or ScheduleWakeup -- they are not available.",
    "- Inspect yourself: `zero whoami` for identity and permissions, `zero agent view $ZERO_AGENT_ID --instructions` for your current settings.",
    "- When the user asks to change your behavior, update your own configuration with `zero agent edit --help`.",
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
  return lines.join("\n");
}

function buildAppendSystemPrompt(args: {
  readonly agent: ZeroAgentRunRecord;
  readonly userInfo: UserInfo;
}): string {
  const identity = buildAgentIdentityPrompt(args.agent);
  return [
    identity,
    buildAgentToolsPrompt(),
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
  const baseAppendSystemPrompt = buildAppendSystemPrompt({
    agent: args.agent,
    userInfo: args.userInfo,
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
    permissionPolicies:
      args.body.permissionPolicies ?? args.permissionPolicies ?? undefined,
    triggerSource:
      args.triggerSource ??
      (args.triggerAgentId ? ("agent" as const) : ("web" as const)),
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

    const agentPermissionPolicies = resolveFirewallPolicies(
      toFirewallPolicies(
        agent.permissionPolicies,
        agent.unknownPermissionPolicies,
      ),
      [...allowedConnectorTypes],
    );

    const framework = resolveAgentFramework(agent.content);
    if (!framework) {
      return badRequestMessage(
        "Agent must have a supported framework configured",
      );
    }

    const prependAdditionalVolumes = [
      ...buildSystemSkillVolumes(allowedConnectorTypes, framework),
      ...buildCustomSkillVolumes(agent.customSkills, framework),
    ];

    return await set(
      createAgentRun$,
      {
        userId: args.userId,
        orgId: args.orgId,
        body: createIntegrationRunBody({
          prompt: args.prompt,
          sessionId: args.sessionId,
          agent,
          userInfo,
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
        prependAdditionalVolumes,
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
        "slackDisplayName" | "slackUserId"
      >;
      readonly callbacks?: readonly RunCallback[];
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
    const agentPermissionPolicies = resolveFirewallPolicies(
      toFirewallPolicies(
        agent.permissionPolicies,
        agent.unknownPermissionPolicies,
      ),
      [...allowedConnectorTypes],
    );

    const framework = resolveAgentFramework(agent.content);
    if (!framework) {
      return badRequestMessage(
        "Agent must have a supported framework configured",
      );
    }

    const prependAdditionalVolumes = [
      ...buildSystemSkillVolumes(allowedConnectorTypes, framework),
      ...buildCustomSkillVolumes(agent.customSkills, framework),
    ];

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
        modelProviderId: agent.modelProviderId ?? undefined,
        modelProviderType: args.body.modelProvider,
        selectedModelOverride:
          args.selectedModelOverride ?? agent.selectedModel ?? undefined,
        extraEnvironment: { ZERO_AGENT_ID: agent.id },
        callbacks: args.callbacks ?? callbacksForTriggerAgent(triggerAgentId),
        includeZeroTokenSecret: true,
        enforceVm0Credits: true,
        queueOnConcurrencyLimit: true,
        prependAdditionalVolumes,
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
