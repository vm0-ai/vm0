import { and, eq } from "drizzle-orm";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { getOrgDefaultModelProvider } from "../model-provider/model-provider-service";
import { escapeHtml } from "./format";

function telegramUserMention(telegramUserId: string): string {
  const href = `tg://user?id=${encodeURIComponent(telegramUserId)}`;
  return `<a href="${escapeHtml(href)}">Telegram user ${escapeHtml(
    telegramUserId,
  )}</a>`;
}

function displayLabel(row: {
  agentDisplayName: string | null;
  agentName: string | null;
  composeName: string;
}): string {
  const displayName = row.agentDisplayName?.trim();
  if (displayName) return displayName;

  const agentName = row.agentName?.trim();
  if (agentName) return agentName;

  return row.composeName.trim() || "zero";
}

async function resolveComposeLabel(
  composeId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
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

async function resolveTelegramRespondedByLabel(
  installationId: string,
  composeId: string,
): Promise<string | undefined> {
  const [installation] = await globalThis.services.db
    .select({ defaultComposeId: telegramInstallations.defaultComposeId })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installationId))
    .limit(1);

  if (installation?.defaultComposeId === composeId) return undefined;

  const label = await resolveComposeLabel(composeId);
  return label ? `Responded by ${escapeHtml(label)}` : undefined;
}

async function countTelegramThreadMentioners(params: {
  chatId: string;
  rootMessageId: string | null | undefined;
  currentUserLinkId: string;
}): Promise<number> {
  if (!params.rootMessageId) return 1;

  const rows = await globalThis.services.db
    .select({ userLinkId: telegramThreadSessions.telegramUserLinkId })
    .from(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.chatId, params.chatId),
        eq(telegramThreadSessions.rootMessageId, params.rootMessageId),
      ),
    );

  const userLinkIds = new Set(
    rows.map((row) => {
      return row.userLinkId;
    }),
  );
  userLinkIds.add(params.currentUserLinkId);
  return userLinkIds.size;
}

async function resolveTelegramUserMention(
  userLinkId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({ telegramUserId: telegramUserLinks.telegramUserId })
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.id, userLinkId))
    .limit(1);

  return row ? telegramUserMention(row.telegramUserId) : undefined;
}

async function resolveRunSelectedModel(
  runId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);

  return row?.selectedModel ?? undefined;
}

async function resolveAgentReplyModelLabel(
  orgId: string,
  runId: string,
): Promise<string | undefined> {
  const selectedModel = await resolveRunSelectedModel(runId);
  const model =
    selectedModel ??
    (await getOrgDefaultModelProvider(orgId, "claude-code"))?.selectedModel;

  return model ? escapeHtml(getModelDisplayName(model)) : undefined;
}

export async function resolveTelegramAgentReplyFooterText(params: {
  orgId: string;
  runId: string;
  installationId: string;
  chatId: string;
  rootMessageId: string | null | undefined;
  userLinkId: string;
  agentId: string;
}): Promise<string | undefined> {
  const [respondedBy, mentionerCount, modelLabel] = await Promise.all([
    resolveTelegramRespondedByLabel(params.installationId, params.agentId),
    countTelegramThreadMentioners({
      chatId: params.chatId,
      rootMessageId: params.rootMessageId,
      currentUserLinkId: params.userLinkId,
    }),
    resolveAgentReplyModelLabel(params.orgId, params.runId),
  ]);

  const parts: string[] = [];
  if (respondedBy) parts.push(respondedBy);
  if (mentionerCount > 1) {
    const replyTo = await resolveTelegramUserMention(params.userLinkId);
    if (replyTo) parts.push(`Reply to ${replyTo}`);
  }
  if (modelLabel) parts.push(modelLabel);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

async function resolveRunAgentLabel(
  runId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
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
  runId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
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

async function resolveRunTelegramUserMention(params: {
  runId: string;
  botId: string;
}): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({ telegramUserId: telegramUserLinks.telegramUserId })
    .from(agentRuns)
    .innerJoin(
      telegramUserLinks,
      and(
        eq(telegramUserLinks.vm0UserId, agentRuns.userId),
        eq(telegramUserLinks.installationId, params.botId),
      ),
    )
    .where(eq(agentRuns.id, params.runId))
    .limit(1);

  return row ? telegramUserMention(row.telegramUserId) : undefined;
}

export async function resolveTelegramMessageSendFooterText(params: {
  authRunId: string | undefined;
  botId: string;
}): Promise<string | undefined> {
  if (!params.authRunId) return undefined;

  const [agentLabel, scheduleLabel, userMention, selectedModel] =
    await Promise.all([
      resolveRunAgentLabel(params.authRunId),
      resolveRunScheduleLabel(params.authRunId),
      resolveRunTelegramUserMention({
        runId: params.authRunId,
        botId: params.botId,
      }),
      resolveRunSelectedModel(params.authRunId),
    ]);

  const parts: string[] = [];
  if (agentLabel) parts.push(`Sent via ${escapeHtml(agentLabel)}`);
  if (scheduleLabel) {
    parts.push(`Triggered by schedule "${escapeHtml(scheduleLabel)}"`);
  }
  if (userMention) {
    parts.push(
      scheduleLabel
        ? `Created by ${userMention}`
        : `Triggered by ${userMention}`,
    );
  }
  if (selectedModel) parts.push(escapeHtml(getModelDisplayName(selectedModel)));

  return parts.length > 0 ? parts.join(" · ") : undefined;
}
