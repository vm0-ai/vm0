import {
  zeroWorkflowTriggersContract,
  type ChatThreadWorkflowAutomation,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { accept } from "../../lib/accept.ts";
import type { ZeroClientFactory } from "../api-client.ts";

/**
 * List workflow triggers bound to a chat thread. Goal triggers are managed by
 * the goal API and are not part of this workflow sidebar surface.
 */
export async function listThreadWorkflowTriggers(
  client: ZeroClientFactory,
  params: { readonly threadId: string },
  fetchOptions?: RequestInit,
): Promise<ChatThreadWorkflowAutomation[]> {
  const result = await accept(
    client(zeroWorkflowTriggersContract).listForChatThread({
      params: { threadId: params.threadId },
      fetchOptions,
    }),
    [200],
  );
  return result.body;
}
