import {
  translationContract,
  type TranslationRequest,
  type TranslationResponse,
} from "@okouai/api-contracts/contracts/translation";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callTranslation(
  body: TranslationRequest,
): Promise<TranslationResponse> {
  const config = await getClientConfig();
  const client = initClient(translationContract, config);
  const result = await client.translate({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to translate text");
}
