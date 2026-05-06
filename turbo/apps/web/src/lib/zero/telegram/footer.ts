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
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { isOfficialTelegramBotId } from "./official";
import { getOrgDefaultModelProvider } from "../model-provider/model-provider-service";
import { escapeHtml } from "./format";

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
  if (username) return `@${username}`;

  const displayName = telegramDisplayName?.trim();
  return displayName ? displayName : `Telegram user ${telegramUserId}`;
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
  if (isOfficialTelegramBotId(installationId)) return undefined;

  const [installation] = await globalThis.services.db
    .select({ defaultComposeId: telegramInstallations.defaultComposeId })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installationId))
    .limit(1);

  if (installation?.defaultComposeId === composeId) return undefined;

  const label = await resolveComposeLabel(composeId);
  return label ? `Responded by ${escapeHtml(label)}` : undefined;
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
  const [respondedBy, modelLabel] = await Promise.all([
    resolveTelegramRespondedByLabel(params.installationId, params.agentId),
    resolveAgentReplyModelLabel(params.orgId, params.runId),
  ]);

  const parts: string[] = [];
  if (respondedBy) parts.push(respondedBy);
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

async function resolveRunUserLabel(params: {
  runId: string;
  botId: string;
}): Promise<string | undefined> {
  const [row] = await globalThis.services.db
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
        eq(telegramUserLinks.installationId, params.botId),
      ),
    )
    .where(eq(agentRuns.id, params.runId))
    .limit(1);

  if (!row) return undefined;

  const label = telegramUserLabel(
    row.telegramUsername,
    row.telegramDisplayName,
    row.telegramUserId,
  );
  return telegramUserMention(row.telegramUserId, label);
}

export async function resolveTelegramMessageSendFooterText(params: {
  authRunId: string | undefined;
  botId: string;
}): Promise<string | undefined> {
  if (!params.authRunId) return undefined;

  const [agentLabel, scheduleLabel, userLabel, selectedModel] =
    await Promise.all([
      resolveRunAgentLabel(params.authRunId),
      resolveRunScheduleLabel(params.authRunId),
      resolveRunUserLabel({
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
  if (userLabel) {
    parts.push(
      scheduleLabel ? `Created by ${userLabel}` : `Triggered by ${userLabel}`,
    );
  }
  if (selectedModel) parts.push(escapeHtml(getModelDisplayName(selectedModel)));

  return parts.length > 0 ? parts.join(" · ") : undefined;
}
