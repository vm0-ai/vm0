import { computed, type Computed } from "ccstate";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { and, desc, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { getMe } from "../external/telegram-client";
import { decryptSecretValue } from "./crypto.utils";

interface TelegramBotListItem {
  readonly id: string;
  readonly username: string | null;
  readonly agent: { readonly id: string; readonly name: string } | null;
  readonly isOwner: boolean;
  readonly isConnected: boolean;
  readonly tokenStatus: "valid" | "invalid" | "unknown";
}

export function zeroTelegramBots(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly TelegramBotListItem[]>> {
  return computed(async (get) => {
    const db = get(db$);

    const installations = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.orgId, args.orgId))
      .orderBy(
        desc(telegramInstallations.createdAt),
        desc(telegramInstallations.telegramBotId),
      );

    if (installations.length === 0) {
      return [];
    }

    const bots = await Promise.all(
      installations.map(async (installation) => {
        const tokenStatus = await resolveTokenStatus(
          installation.encryptedBotToken,
        );

        let agent: { id: string; name: string } | null = null;
        const [agentRow] = await db
          .select({ id: zeroAgents.id, name: zeroAgents.name })
          .from(agentComposes)
          .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
          .where(eq(agentComposes.id, installation.defaultComposeId))
          .limit(1);
        if (agentRow) {
          agent = { id: agentRow.id, name: agentRow.name };
        }

        return {
          id: installation.telegramBotId,
          username: installation.botUsername ?? null,
          agent,
          isOwner: installation.ownerUserId === args.userId,
          isConnected: tokenStatus === "valid",
          tokenStatus,
        };
      }),
    );

    return bots;
  });
}

export function zeroTelegramInstallation(args: {
  readonly orgId: string;
  readonly botId: string;
}): Computed<
  Promise<{
    readonly botToken: string;
    readonly botUsername: string | null;
  } | null>
> {
  return computed(async (get) => {
    const db = get(db$);

    const [row] = await db
      .select({
        encryptedBotToken: telegramInstallations.encryptedBotToken,
        botUsername: telegramInstallations.botUsername,
      })
      .from(telegramInstallations)
      .where(
        and(
          eq(telegramInstallations.telegramBotId, args.botId),
          eq(telegramInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      botToken: decryptSecretValue(row.encryptedBotToken),
      botUsername: row.botUsername ?? null,
    };
  });
}

function resolveTokenStatus(
  encryptedBotToken: string,
): Promise<"valid" | "invalid" | "unknown"> {
  const token = decryptSecretValue(encryptedBotToken);
  return getMe(token)
    .then(() => {
      return "valid" as const;
    })
    .catch(() => {
      return "unknown" as const;
    });
}
