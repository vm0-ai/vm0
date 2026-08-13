import {
  zeroWebSearchContract,
  type ZeroWebSearchRequest,
  type ZeroWebSearchResponse,
} from "@okouai/api-contracts/contracts/zero-web-search";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callZeroWebSearch(
  body: ZeroWebSearchRequest,
): Promise<ZeroWebSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroWebSearchContract, config);

  const result = await client.search({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to search the web");
}
