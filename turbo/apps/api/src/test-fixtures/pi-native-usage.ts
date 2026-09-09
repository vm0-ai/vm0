import type { PiModelConfigV4 } from "@okouai/api-contracts/contracts/pi-native";
import type { PiApiFirstTurnResult } from "@okouai/pi-agent-runtime/api";
import { db } from "../lib/db";
import { recordPiApiFirstTurnUsage } from "../signals/services/pi-api-first-turn-usage.service";

/**
 * The preparation release deliberately has no native production writer. This
 * private infrastructure fixture supplies only future terminal provider usage;
 * identity/lifecycle setup still uses the real run API. It is not an admission
 * override and becomes unnecessary when the activation issue owns a writer.
 */
export async function recordNativeUsageFixture(args: {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly nativeModelConfig: PiModelConfigV4;
  readonly turn: PiApiFirstTurnResult;
}): Promise<void> {
  await recordPiApiFirstTurnUsage(db(), {
    ...args,
    billableFirewalls: ["model-provider:anthropic-api-key"],
    modelUsageProvider: args.nativeModelConfig.catalogModel,
    piProvider: "anthropic",
    requestedServiceTier: undefined,
  });
}
