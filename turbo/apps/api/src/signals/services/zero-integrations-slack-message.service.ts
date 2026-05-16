import { computed, type Computed } from "ccstate";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { tapError } from "../utils";

async function resolveAgentLabel(
  db: ReadonlyDb,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      displayName: zeroAgents.displayName,
      name: zeroAgents.name,
    })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .innerJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.displayName ?? row?.name ?? undefined;
}

async function resolveScheduleLabel(
  db: ReadonlyDb,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ description: zeroAgentSchedules.description })
    .from(zeroRuns)
    .innerJoin(
      zeroAgentSchedules,
      eq(zeroRuns.scheduleId, zeroAgentSchedules.id),
    )
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.description ?? undefined;
}

async function resolveSelectedModel(
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

async function resolveUserMention(
  db: ReadonlyDb,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(agentRuns)
    .innerJoin(
      slackOrgInstallations,
      eq(slackOrgInstallations.orgId, agentRuns.orgId),
    )
    .innerJoin(
      slackOrgConnections,
      and(
        eq(slackOrgConnections.vm0UserId, agentRuns.userId),
        eq(
          slackOrgConnections.slackWorkspaceId,
          slackOrgInstallations.slackWorkspaceId,
        ),
      ),
    )
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ? `<@${row.slackUserId}>` : undefined;
}

/**
 * Resolve the audit footer text appended to user-initiated Slack messages.
 *
 * Mirrors apps/web/app/api/zero/integrations/slack/message/route.ts
 * `resolveFooterParts`. Each resolver swallows its own errors so any single
 * lookup failure degrades the footer gracefully.
 */
export function slackMessageSendFooterText(args: {
  readonly authRunId: string | undefined;
}): Computed<Promise<string | undefined>> {
  return computed(async (get): Promise<string | undefined> => {
    if (!args.authRunId) {
      return undefined;
    }
    const db = get(db$);
    const runId = args.authRunId;

    const noop = (): void => {};
    const [agentLabel, scheduleLabel, userMention, selectedModel] =
      await Promise.all([
        tapError(resolveAgentLabel(db, runId), noop),
        tapError(resolveScheduleLabel(db, runId), noop),
        tapError(resolveUserMention(db, runId), noop),
        tapError(resolveSelectedModel(db, runId), noop),
      ]);

    const parts: string[] = [];
    if (agentLabel) {
      parts.push(`Sent via ${agentLabel}`);
    }
    if (scheduleLabel) {
      parts.push(`Triggered by schedule "${scheduleLabel}"`);
    }
    if (userMention) {
      parts.push(
        scheduleLabel
          ? `Created by ${userMention}`
          : `Triggered by ${userMention}`,
      );
    }
    if (selectedModel) {
      parts.push(getModelDisplayName(selectedModel));
    }

    return parts.length > 0 ? parts.join(" · ") : undefined;
  });
}

/**
 * Resolve the current user's Slack user ID via the org's Slack installation.
 * Used to expand `user: "me"` recipients in the send-message route.
 */
export function resolveCurrentUserSlackId(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ slackUserId: slackOrgConnections.slackUserId })
      .from(slackOrgConnections)
      .innerJoin(
        slackOrgInstallations,
        eq(
          slackOrgConnections.slackWorkspaceId,
          slackOrgInstallations.slackWorkspaceId,
        ),
      )
      .where(
        and(
          eq(slackOrgConnections.vm0UserId, args.userId),
          eq(slackOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);
    return row?.slackUserId ?? null;
  });
}
