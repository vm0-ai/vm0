import {
  zeroRecognitionContract,
  type ZeroRecognitionRequest,
  type ZeroRecognitionResponse,
} from "@vm0/api-contracts/contracts/zero-recognition";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callZeroRecognition(
  body: ZeroRecognitionRequest,
): Promise<ZeroRecognitionResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroRecognitionContract, config);
  const result = await client.recognize({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to recognize image");
}
