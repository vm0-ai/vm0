import {
  imageRecognitionContract,
  type ImageRecognitionRequest,
  type ImageRecognitionResponse,
} from "@okouai/api-contracts/contracts/image-recognition";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

type ImageRecognitionOperation = "imageRecognition" | "recognize";

async function callImageRecognitionOperation(
  operation: ImageRecognitionOperation,
  body: ImageRecognitionRequest,
): Promise<ImageRecognitionResponse> {
  const config = await getClientConfig();
  const client = initClient(imageRecognitionContract, config);
  const result =
    operation === "imageRecognition"
      ? await client.imageRecognition({ headers: {}, body })
      : await client.recognize({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to recognize image");
}

export async function callImageRecognition(
  body: ImageRecognitionRequest,
): Promise<ImageRecognitionResponse> {
  return callImageRecognitionOperation("imageRecognition", body);
}

export async function callImageRecognitionCompatibility(
  body: ImageRecognitionRequest,
): Promise<ImageRecognitionResponse> {
  return callImageRecognitionOperation("recognize", body);
}
