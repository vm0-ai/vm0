import {
  socialContract,
  type SocialTranscriptRequest,
  type SocialTranscriptResponse,
} from "@okouai/api-contracts/contracts/social";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callSocialTranscript(
  body: SocialTranscriptRequest,
): Promise<SocialTranscriptResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.transcript({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to retrieve the social transcript");
}
