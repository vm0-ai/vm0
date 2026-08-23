import { getModelDisplayName } from "@okouai/core/model-display-name";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { and, eq, isNotNull } from "drizzle-orm";

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
  return row.composeName.trim() || "Okou";
}

async function resolveComposeLabel(
  db: ReadonlyDb,
  composeId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      agentDisplayName: agents.displayName,
      agentName: agents.name,
      composeName: agents.name,
    })
    .from(agents)
    .where(eq(agents.id, composeId))
    .limit(1);
  return row ? displayLabel(row) : undefined;
}

async function resolveGithubRespondedByLabel(args: {
  readonly db: ReadonlyDb;
  readonly installationId: string;
  readonly composeId: string;
}): Promise<string | undefined> {
  const [installation] = await args.db
    .select({ defaultAgentId: githubInstallations.defaultAgentId })
    .from(githubInstallations)
    .where(eq(githubInstallations.id, args.installationId))
    .limit(1);

  if (installation?.defaultAgentId === args.composeId) {
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
    .select({ selectedModel: agentRuns.selectedModel })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
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
