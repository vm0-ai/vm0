import {
  imageRecognitionContract,
  type ImageRecognitionRequest,
  type ImageRecognitionResponse,
} from "@okouai/api-contracts/contracts/image-recognition";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callImageRecognition(
  body: ImageRecognitionRequest,
): Promise<ImageRecognitionResponse> {
  const config = await getClientConfig();
  const client = initClient(imageRecognitionContract, config);
  const result = await client.recognize({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to recognize image");
}
