import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  zeroMailContract,
  type ZeroMailDraft,
  type ZeroMailProvider,
} from "@vm0/api-contracts/contracts/zero-mail";

import { getClientConfig, handleError } from "../core/client-factory";

export async function createZeroMailDraft(args: {
  readonly threadId: string;
  readonly agentId: string;
  readonly provider: ZeroMailProvider | undefined;
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
}): Promise<{ readonly messageId: string; readonly mailDraft: ZeroMailDraft }> {
  const config = await getClientConfig();
  const client = initClient(zeroMailContract, config);
  const result = await client.createDraft({
    body: { ...args, to: [...args.to] },
  });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to create mail draft");
}
