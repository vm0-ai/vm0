import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { eq, inArray } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";
import { encryptSecretForTests } from "./encrypt-secret";

export interface TelegramFixture {
  readonly orgId: string;
  readonly composeIds: readonly string[];
  readonly telegramBotIds: readonly string[];
  readonly userIds: readonly string[];
}

interface TelegramFixtureBuilder {
  readonly orgId: string;
  readonly composeIds: string[];
  readonly telegramBotIds: string[];
  readonly userIds: string[];
}

interface SeedTelegramInstallationValues {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly telegramBotId: string;
  readonly botUsername?: string | null;
  readonly defaultComposeId?: string;
  readonly composeUserId?: string;
  readonly composeName?: string;
  readonly agentName?: string;
}

interface SeedOrgDefaultAgentValues {
  readonly orgId: string;
  readonly userId: string;
  readonly composeName?: string;
  readonly agentName?: string;
}

interface SeedOfficialUserLinkValues {
  readonly orgId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}

interface SeedTelegramUserLinkValues {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly vm0UserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}

interface SeedUserAgentPreferenceValues {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
}

export const seedTelegramInstallation$ = command(
  async (
    { set },
    values: SeedTelegramInstallationValues,
    signal: AbortSignal,
  ): Promise<{
    readonly composeId: string;
    readonly telegramBotId: string;
  }> => {
    const writeDb = set(writeDb$);
    const composeId = values.defaultComposeId ?? randomUUID();
    const composeUserId = values.composeUserId ?? values.ownerUserId;
    const composeName = values.composeName ?? `agent-${composeId.slice(0, 8)}`;
    const agentName = values.agentName ?? composeName;

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId: composeUserId,
      orgId: values.orgId,
      name: composeName,
    });
    signal.throwIfAborted();
    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId: values.orgId,
      owner: composeUserId,
      name: agentName,
    });
    signal.throwIfAborted();
    await writeDb.insert(telegramInstallations).values({
      telegramBotId: values.telegramBotId,
      botUsername:
        values.botUsername === undefined
          ? `bot_${values.telegramBotId}`
          : values.botUsername,
      encryptedBotToken: encryptSecretForTests("test-bot-token"),
      webhookSecret: `whs_${randomUUID()}`,
      defaultComposeId: composeId,
      ownerUserId: values.ownerUserId,
      orgId: values.orgId,
    });
    signal.throwIfAborted();

    return { composeId, telegramBotId: values.telegramBotId };
  },
);

export const seedOrgDefaultAgent$ = command(
  async (
    { set },
    values: SeedOrgDefaultAgentValues,
    signal: AbortSignal,
  ): Promise<{ readonly composeId: string }> => {
    const writeDb = set(writeDb$);
    const composeId = randomUUID();
    const composeName = values.composeName ?? `agent-${composeId.slice(0, 8)}`;
    const agentName = values.agentName ?? composeName;

    await writeDb.insert(agentComposes).values({
      id: composeId,
      userId: values.userId,
      orgId: values.orgId,
      name: composeName,
    });
    signal.throwIfAborted();
    await writeDb.insert(zeroAgents).values({
      id: composeId,
      orgId: values.orgId,
      owner: values.userId,
      name: agentName,
    });
    signal.throwIfAborted();
    await writeDb
      .insert(orgMetadata)
      .values({
        orgId: values.orgId,
        defaultAgentId: composeId,
        tier: "free",
        credits: 10_000,
      })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { defaultAgentId: composeId, tier: "free", credits: 10_000 },
      });
    signal.throwIfAborted();

    return { composeId };
  },
);

export const seedOfficialUserLink$ = command(
  async (
    { set },
    values: SeedOfficialUserLinkValues,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(telegramOfficialUserLinks).values({
      orgId: values.orgId,
      vm0UserId: values.userId,
      telegramUserId: values.telegramUserId,
      telegramUsername: values.telegramUsername ?? null,
      telegramDisplayName: values.telegramDisplayName ?? null,
    });
    signal.throwIfAborted();
  },
);

export const seedTelegramUserLink$ = command(
  async (
    { set },
    values: SeedTelegramUserLinkValues,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.insert(telegramUserLinks).values({
      installationId: values.installationId,
      telegramUserId: values.telegramUserId,
      vm0UserId: values.vm0UserId,
      telegramUsername: values.telegramUsername ?? null,
      telegramDisplayName: values.telegramDisplayName ?? null,
    });
    signal.throwIfAborted();
  },
);

export const seedUserAgentPreference$ = command(
  async (
    { set },
    values: SeedUserAgentPreferenceValues,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .insert(telegramUserAgentPreferences)
      .values({
        orgId: values.orgId,
        vm0UserId: values.userId,
        selectedComposeId: values.composeId,
      })
      .onConflictDoUpdate({
        target: [
          telegramUserAgentPreferences.vm0UserId,
          telegramUserAgentPreferences.orgId,
        ],
        set: { selectedComposeId: values.composeId },
      });
    signal.throwIfAborted();
  },
);

export const deleteTelegramFixture$ = command(
  async (
    { set },
    fixture: TelegramFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(telegramOfficialUserLinks)
      .where(eq(telegramOfficialUserLinks.orgId, fixture.orgId));
    signal.throwIfAborted();
    await writeDb
      .delete(telegramUserAgentPreferences)
      .where(eq(telegramUserAgentPreferences.orgId, fixture.orgId));
    signal.throwIfAborted();
    if (fixture.telegramBotIds.length > 0) {
      await writeDb
        .delete(telegramInstallations)
        .where(
          inArray(telegramInstallations.telegramBotId, [
            ...fixture.telegramBotIds,
          ]),
        );
      signal.throwIfAborted();
    }
    if (fixture.composeIds.length > 0) {
      await writeDb
        .delete(zeroAgents)
        .where(inArray(zeroAgents.id, [...fixture.composeIds]));
      signal.throwIfAborted();
      await writeDb
        .delete(agentComposes)
        .where(inArray(agentComposes.id, [...fixture.composeIds]));
      signal.throwIfAborted();
    }
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

export function makeTelegramFixtureBuilder(
  orgId: string,
): TelegramFixtureBuilder {
  return {
    orgId,
    composeIds: [],
    telegramBotIds: [],
    userIds: [],
  };
}

export function freezeTelegramFixture(
  builder: TelegramFixtureBuilder,
): TelegramFixture {
  return {
    orgId: builder.orgId,
    composeIds: [...builder.composeIds],
    telegramBotIds: [...builder.telegramBotIds],
    userIds: [...builder.userIds],
  };
}
