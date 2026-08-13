import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { zeroMailContract } from "@okouai/api-contracts/contracts/zero-mail";

import { getClientConfig, handleError } from "../core/client-factory";

export async function linkZeroMailDraft(args: {
  readonly threadId: string;
  readonly agentId: string;
  readonly gmailDraftId: string;
}): Promise<{
  readonly mailDraftId: string;
  readonly mailDraftUrl: string;
}> {
  const config = await getClientConfig();
  const client = initClient(zeroMailContract, config);
  const result = await client.linkDraft({
    body: {
      threadId: args.threadId,
      agentId: args.agentId,
      gmailDraftId: args.gmailDraftId,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to link Gmail draft");
}
