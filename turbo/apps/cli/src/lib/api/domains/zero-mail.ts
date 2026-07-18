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
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly replyTo?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly gmailThreadId?: string;
}): Promise<{
  readonly mailDraftId: string;
  readonly mailDraftUrl: string;
  readonly mailDraft: ZeroMailDraft;
}> {
  const config = await getClientConfig();
  const client = initClient(zeroMailContract, config);
  const result = await client.createDraft({
    body: {
      threadId: args.threadId,
      agentId: args.agentId,
      provider: args.provider,
      to: [...args.to],
      cc: args.cc ? [...args.cc] : undefined,
      bcc: args.bcc ? [...args.bcc] : undefined,
      subject: args.subject,
      body: args.body,
      replyTo: args.replyTo,
      inReplyTo: args.inReplyTo,
      references: args.references ? [...args.references] : undefined,
      gmailThreadId: args.gmailThreadId,
    },
  });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to create mail draft");
}
