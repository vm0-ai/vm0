import { initClient } from "@ts-rest/core";
import { integrationsSlackMessageContract } from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

interface SendSlackMessageParams {
  channel: string;
  text?: string;
  threadTs?: string;
  blocks?: Array<{ type: string; [key: string]: unknown }>;
}

interface SendSlackMessageResult {
  ok: true;
  ts?: string;
  channel?: string;
}

export async function sendSlackMessage(
  body: SendSlackMessageParams,
): Promise<SendSlackMessageResult> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackMessageContract, config);

  const result = await client.sendMessage({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to send Slack message");
}
