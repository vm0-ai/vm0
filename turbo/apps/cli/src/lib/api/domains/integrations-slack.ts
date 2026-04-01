import { initClient } from "@ts-rest/core";
import {
  integrationsSlackMessageContract,
  integrationsSlackUploadInitContract,
  integrationsSlackUploadCompleteContract,
  type SendSlackMessageBody,
  type SendSlackMessageResponse,
  type SlackUploadInitBody,
  type SlackUploadInitResponse,
  type SlackUploadCompleteBody,
  type SlackUploadCompleteResponse,
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

export async function initSlackFileUpload(
  body: SlackUploadInitBody,
): Promise<SlackUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackUploadInitContract, config);

  const result = await client.init({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to initialize Slack file upload");
}

export async function completeSlackFileUpload(
  body: SlackUploadCompleteBody,
): Promise<SlackUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackUploadCompleteContract, config);

  const result = await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete Slack file upload");
}
