import { initClient } from "@ts-rest/core";
import {
  integrationsChatMessageContract,
  type SendChatMessageBody,
  type SendChatMessageResponse,
} from "@vm0/api-contracts/contracts/integrations";
import { getClientConfig, handleError } from "../core/client-factory";

export async function sendChatMessage(
  body: SendChatMessageBody,
): Promise<SendChatMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsChatMessageContract, config);

  const result = await client.sendMessage({ body, headers: {} });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to send chat message");
}
