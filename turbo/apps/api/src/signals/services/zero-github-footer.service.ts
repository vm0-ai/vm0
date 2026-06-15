import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@vm0/api-contracts/contracts/model-providers";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

const ORG_SENTINEL_USER_ID = "__org__";

function displayLabel(row: {
  readonly agentDisplayName: string | null;
  readonly agentName: string | null;
  readonly composeName: string;
}): string {
  const displayName = row.agentDisplayName?.trim();
  if (displayName) {
    return displayName;
  }
  const agentName = row.agentName?.trim();
  if (agentName) {
    return agentName;
  }
  return row.composeName.trim() || "zero";
}

async function resolveComposeLabel(
  db: ReadonlyDb,
  composeId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      agentDisplayName: zeroAgents.displayName,
      agentName: zeroAgents.name,
      composeName: agentComposes.name,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return row ? displayLabel(row) : undefined;
}

async function resolveGithubRespondedByLabel(args: {
  readonly db: ReadonlyDb;
  readonly installationId: string;
  readonly composeId: string;
}): Promise<string | undefined> {
  const [installation] = await args.db
    .select({ defaultComposeId: githubInstallations.defaultComposeId })
    .from(githubInstallations)
    .where(eq(githubInstallations.id, args.installationId))
    .limit(1);

  if (installation?.defaultComposeId === args.composeId) {
    return undefined;
  }

  const label = await resolveComposeLabel(args.db, args.composeId);
  return label ? `Responded by ${label}` : undefined;
}

async function resolveOrgDefaultModelProviderSelectedModel(
  db: ReadonlyDb,
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

async function resolveRunSelectedModel(
  db: ReadonlyDb,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.selectedModel ?? undefined;
}

async function resolveAgentReplyModelLabel(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly runId: string;
}): Promise<string | undefined> {
  const selectedModel = await resolveRunSelectedModel(args.db, args.runId);
  const model =
    selectedModel ??
    (await resolveOrgDefaultModelProviderSelectedModel(args.db, args.orgId));

  return model ? getModelDisplayName(model) : undefined;
}

export async function resolveGithubAgentReplyFooterText(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly runId: string;
  readonly installationId: string;
  readonly agentId: string;
}): Promise<string | undefined> {
  const [respondedBy, modelLabel] = await Promise.all([
    resolveGithubRespondedByLabel({
      db: args.db,
      installationId: args.installationId,
      composeId: args.agentId,
    }),
    resolveAgentReplyModelLabel({
      db: args.db,
      orgId: args.orgId,
      runId: args.runId,
    }),
  ]);

  const parts: string[] = [];
  if (respondedBy) {
    parts.push(respondedBy);
  }
  if (modelLabel) {
    parts.push(modelLabel);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}
