import {
  zeroTranslationContract,
  type ZeroTranslationRequest,
  type ZeroTranslationResponse,
} from "@vm0/api-contracts/contracts/zero-translation";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callZeroTranslation(
  body: ZeroTranslationRequest,
): Promise<ZeroTranslationResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroTranslationContract, config);
  const result = await client.translate({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to translate text");
}
