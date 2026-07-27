import { and, eq } from "drizzle-orm";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { env } from "../../lib/env";
import type { Db } from "../external/db";

const ORG_SENTINEL_USER_ID = "__org__";

function buildLogsUrl(runId: string): string {
  return `${env("APP_URL")}/activities/${encodeURIComponent(runId)}`;
}

async function resolveRunSelectedModel(
  db: Db,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.selectedModel ?? undefined;
}

async function resolveRespondedByLabel(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly composeId: string;
  readonly defaultAgentId?: string;
}): Promise<string | undefined> {
  const defaultAgentId =
    args.defaultAgentId ??
    (
      await args.db
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1)
    )[0]?.defaultAgentId;

  if (args.composeId === defaultAgentId) {
    return undefined;
  }

  const [agent] = await args.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, args.composeId))
    .limit(1);
  const label = agent?.displayName ?? agent?.name;
  return label ? `Responded by ${label}` : undefined;
}

async function resolveOrgDefaultModelProviderSelectedModel(
  db: Db,
  orgId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    );
  const row = rows.find((candidate) => {
    const parsed = modelProviderTypeSchema.safeParse(candidate.type);
    return parsed.success && getFrameworkForType(parsed.data) === "claude-code";
  });
  return row?.selectedModel ?? undefined;
}

async function resolveModelLabel(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly runId: string;
}): Promise<string | undefined> {
  const selectedModel = await resolveRunSelectedModel(args.db, args.runId);
  const model =
    selectedModel ??
    (await resolveOrgDefaultModelProviderSelectedModel(args.db, args.orgId));
  return model ? getModelDisplayName(model) : undefined;
}

export async function resolveIntegrationAgentResponsePresentation(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly defaultAgentId?: string;
  readonly replyToMention?: string;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<{
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}> {
  const [respondedBy, modelLabel, overrides] = await Promise.all([
    resolveRespondedByLabel({
      db: args.db,
      orgId: args.orgId,
      composeId: args.agentId,
      defaultAgentId: args.defaultAgentId,
    }),
    resolveModelLabel({
      db: args.db,
      orgId: args.orgId,
      runId: args.runId,
    }),
    args.getFeatureOverrides(args.orgId, args.userId),
  ]);
  args.signal.throwIfAborted();

  const parts: string[] = [];
  if (respondedBy) {
    parts.push(respondedBy);
  }
  if (args.replyToMention) {
    parts.push(`Reply to ${args.replyToMention}`);
  }
  if (modelLabel) {
    parts.push(modelLabel);
  }

  const typedOverrides =
    Object.keys(overrides).length > 0
      ? (overrides as Partial<Record<FeatureSwitchKey, boolean>>)
      : undefined;
  const enabled = isFeatureEnabled(FeatureSwitchKey.ZeroDebug, {
    userId: args.userId,
    orgId: args.orgId,
    overrides: typedOverrides,
  });
  return {
    logsUrl: enabled ? buildLogsUrl(args.runId) : undefined,
    footerText: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}
