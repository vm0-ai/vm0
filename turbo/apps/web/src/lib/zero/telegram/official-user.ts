import { and, eq } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { resolveDefaultAgentId } from "../resolve-default-agent";

export async function getTelegramUserAgentPreference(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({
      selectedComposeId: telegramUserAgentPreferences.selectedComposeId,
    })
    .from(telegramUserAgentPreferences)
    .where(
      and(
        eq(telegramUserAgentPreferences.vm0UserId, vm0UserId),
        eq(telegramUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);

  return row?.selectedComposeId ?? null;
}

export async function setTelegramUserAgentPreference(opts: {
  vm0UserId: string;
  orgId: string;
  composeId: string | null;
}): Promise<void> {
  await globalThis.services.db
    .insert(telegramUserAgentPreferences)
    .values({
      vm0UserId: opts.vm0UserId,
      orgId: opts.orgId,
      selectedComposeId: opts.composeId,
    })
    .onConflictDoUpdate({
      target: [
        telegramUserAgentPreferences.vm0UserId,
        telegramUserAgentPreferences.orgId,
      ],
      set: {
        selectedComposeId: opts.composeId,
        updatedAt: new Date(),
      },
    });
}

export async function resolveEffectiveTelegramComposeId(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const preference = await getTelegramUserAgentPreference(vm0UserId, orgId);
  if (preference) {
    const [compose] = await globalThis.services.db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(eq(agentComposes.id, preference), eq(agentComposes.orgId, orgId)),
      )
      .limit(1);

    if (compose?.id) return preference;
  }

  return resolveDefaultAgentId(orgId);
}
