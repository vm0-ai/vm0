import { initClient } from "@ts-rest/core";
import {
  integrationsSlackMessageContract,
  type SendSlackMessageBody,
  type SendSlackMessageResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function sendSlackMessage(
  body: SendSlackMessageBody,
): Promise<SendSlackMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackMessageContract, config);

  const result = await client.sendMessage({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to send Slack message");
}
