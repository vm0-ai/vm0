import { computed, type Computed } from "ccstate";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { escapeHtml } from "../../lib/telegram-format";

function telegramUserMention(telegramUserId: string, label: string): string {
  const href = `tg://user?id=${encodeURIComponent(telegramUserId)}`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function telegramUserLabel(
  telegramUsername: string | null | undefined,
  telegramDisplayName: string | null | undefined,
  telegramUserId: string,
): string {
  const username = telegramUsername?.trim().replace(/^@+/, "");
  if (username) {
    return `@${username}`;
  }
  const displayName = telegramDisplayName?.trim();
  return displayName || `Telegram user ${telegramUserId}`;
}

function displayLabel(row: {
  agentDisplayName: string | null;
  agentName: string | null;
  composeName: string;
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

async function resolveRunAgentLabel(
  db: ReadonlyDb,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      agentDisplayName: zeroAgents.displayName,
      agentName: zeroAgents.name,
      composeName: agentComposes.name,
    })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .innerJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .leftJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ? displayLabel(row) : undefined;
}

async function resolveRunScheduleLabel(
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

async function resolveRunUserLabel(
  db: ReadonlyDb,
  args: { readonly runId: string; readonly botId: string },
): Promise<string | undefined> {
  const [row] = await db
    .select({
      telegramUserId: telegramUserLinks.telegramUserId,
      telegramUsername: telegramUserLinks.telegramUsername,
      telegramDisplayName: telegramUserLinks.telegramDisplayName,
    })
    .from(agentRuns)
    .innerJoin(
      telegramUserLinks,
      and(
        eq(telegramUserLinks.vm0UserId, agentRuns.userId),
        eq(telegramUserLinks.installationId, args.botId),
      ),
    )
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  if (!row) {
    return undefined;
  }
  const label = telegramUserLabel(
    row.telegramUsername,
    row.telegramDisplayName,
    row.telegramUserId,
  );
  return telegramUserMention(row.telegramUserId, label);
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

/**
 * Resolve the audit footer text appended to user-initiated Telegram messages.
 *
 * Mirrors apps/web/src/lib/zero/telegram/footer.ts:resolveTelegramMessageSendFooterText
 * verbatim. Returns undefined when authRunId is undefined (auth source has no
 * run context) or when none of the four data points are available.
 */
export function telegramMessageSendFooterText(args: {
  readonly authRunId: string | undefined;
  readonly botId: string;
}): Computed<Promise<string | undefined>> {
  return computed(async (get): Promise<string | undefined> => {
    if (!args.authRunId) {
      return undefined;
    }
    const db = get(db$);

    const [agentLabel, scheduleLabel, userLabel, selectedModel] =
      await Promise.all([
        resolveRunAgentLabel(db, args.authRunId),
        resolveRunScheduleLabel(db, args.authRunId),
        resolveRunUserLabel(db, {
          runId: args.authRunId,
          botId: args.botId,
        }),
        resolveRunSelectedModel(db, args.authRunId),
      ]);

    const parts: string[] = [];
    if (agentLabel) {
      parts.push(`Sent via ${escapeHtml(agentLabel)}`);
    }
    if (scheduleLabel) {
      parts.push(`Triggered by schedule "${escapeHtml(scheduleLabel)}"`);
    }
    if (userLabel) {
      parts.push(
        scheduleLabel ? `Created by ${userLabel}` : `Triggered by ${userLabel}`,
      );
    }
    if (selectedModel) {
      parts.push(escapeHtml(getModelDisplayName(selectedModel)));
    }

    return parts.length > 0 ? parts.join(" · ") : undefined;
  });
}
