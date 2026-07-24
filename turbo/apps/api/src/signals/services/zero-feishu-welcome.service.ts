import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { buildFeishuWelcomeMessage } from "../../lib/feishu-message-card";
import { sendFeishuMessage } from "../external/feishu-client";
import type { Db } from "../external/db";

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
}
