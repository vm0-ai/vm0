import {
  zeroWebSearchContract,
  type ZeroWebSearchRequest,
  type ZeroWebSearchResponse,
} from "@vm0/api-contracts/contracts/zero-web-search";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export type { ZeroWebSearchResponse } from "@vm0/api-contracts/contracts/zero-web-search";

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
