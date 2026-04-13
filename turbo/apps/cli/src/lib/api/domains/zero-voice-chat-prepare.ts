import { initClient } from "@ts-rest/core";
import {
  zeroVoiceChatPrepareCompleteContract,
  type PrepareCompleteResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function completeVoiceChatPreparation(
  content: string,
): Promise<PrepareCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroVoiceChatPrepareCompleteContract, config);

  const result = await client.complete({
    body: { content },
    headers: {},
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete voice-chat preparation");
}
