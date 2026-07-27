import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { buildFeishuWelcomeMessage } from "../../lib/feishu-message-card";
import { sendFeishuMessage } from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { logger } from "../../lib/log";
import { settle } from "../utils";

const L = logger("ZeroFeishuWelcome");
const WELCOME_RETRY_LIMIT = 20;

export async function notifyFeishuConnect(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly connectionId: string;
  readonly openId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const [installation] = await args.db
    .select({
      agentName: zeroAgents.name,
      agentDisplayName: zeroAgents.displayName,
    })
    .from(feishuOrgInstallations)
    .leftJoin(
      zeroAgents,
      eq(zeroAgents.id, feishuOrgInstallations.defaultComposeId),
    )
    .where(eq(feishuOrgInstallations.id, args.installationId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!installation) {
    throw new Error("Feishu installation not found");
  }
  await sendFeishuMessage({
    db: args.db,
    installationId: args.installationId,
    receiveIdType: "open_id",
    receiveId: args.openId,
    message: buildFeishuWelcomeMessage({
      agentName: installation.agentDisplayName ?? installation.agentName,
    }),
    idempotencyKey: args.connectionId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  await args.db
    .update(feishuOrgConnections)
    .set({ dmWelcomeSent: true, updatedAt: nowDate() })
    .where(
      and(
        eq(feishuOrgConnections.id, args.connectionId),
        eq(feishuOrgConnections.installationId, args.installationId),
        eq(feishuOrgConnections.feishuOpenId, args.openId),
        eq(feishuOrgConnections.dmWelcomeSent, false),
      ),
    );
}

export const retryPendingFeishuConnectWelcomes$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        connectionId: feishuOrgConnections.id,
        installationId: feishuOrgConnections.installationId,
        openId: feishuOrgConnections.feishuOpenId,
      })
      .from(feishuOrgConnections)
      .where(eq(feishuOrgConnections.dmWelcomeSent, false))
      .orderBy(feishuOrgConnections.createdAt)
      .limit(WELCOME_RETRY_LIMIT);
    signal.throwIfAborted();

    let delivered = 0;
    for (const row of rows) {
      const result = await settle(
        notifyFeishuConnect({
          db,
          installationId: row.installationId,
          connectionId: row.connectionId,
          openId: row.openId,
          signal,
        }),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok) {
        delivered++;
      } else {
        L.warn("Failed to retry Feishu connect welcome", {
          connectionId: row.connectionId,
          error: result.error,
        });
      }
    }
    return delivered;
  },
);
