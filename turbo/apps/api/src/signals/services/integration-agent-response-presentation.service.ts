import { and, eq } from "drizzle-orm";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { appUrlForPublicBrand } from "@okouai/core/public-brand";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";

import { env } from "../../lib/env";
import type { Db } from "../external/db";
import { resolveRunModelSelection } from "./run-model-selection.service";

const ORG_SENTINEL_USER_ID = "__org__";

function buildLogsUrl(runId: string, publicBrand: PublicBrand): string {
  return `${appUrlForPublicBrand(env("APP_URL"), publicBrand)}/activities/${encodeURIComponent(runId)}`;
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
    .select({ displayName: agents.displayName, name: agents.name })
    .from(agents)
    .where(eq(agents.id, args.composeId))
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
  const runModel = await resolveRunModelSelection(args.db, args.runId);
  const model =
    runModel?.selectedModel ??
    (await resolveOrgDefaultModelProviderSelectedModel(args.db, args.orgId));
  return model
    ? getRunModelDisplayName(model, runModel?.codexServiceTier)
    : undefined;
}

export async function resolveIntegrationAgentResponsePresentation(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly publicBrand: PublicBrand;
    readonly defaultAgentId?: string;
    readonly replyToMention?: string;
    readonly getFeatureOverrides: (
      orgId: string,
      userId: string,
    ) => Promise<Record<string, boolean>>;
  },
  signal: AbortSignal,
): Promise<{
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
  signal.throwIfAborted();

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
  const enabled = isFeatureEnabled(FeatureSwitchKey.OkouDebug, {
    userId: args.userId,
    orgId: args.orgId,
    overrides: typedOverrides,
  });
  return {
    logsUrl: enabled ? buildLogsUrl(args.runId, args.publicBrand) : undefined,
    footerText: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}
