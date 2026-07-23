import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  integrationsFeishuMessageContract,
  type SendFeishuMessageBody,
  type SendFeishuMessageResponse,
} from "@vm0/api-contracts/contracts/integrations";

import { getClientConfig, handleError } from "../core/client-factory";

export async function sendFeishuMessage(
  body: SendFeishuMessageBody,
): Promise<SendFeishuMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsFeishuMessageContract, config);
  const result = await client.sendMessage({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to send Feishu message");
}
