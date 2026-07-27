import {
  zeroPeopleSearchContract,
  type ZeroPeopleSearchRequest,
  type ZeroPeopleSearchResponse,
} from "@vm0/api-contracts/contracts/zero-people-search";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export type { ZeroPeopleSearchResponse } from "@vm0/api-contracts/contracts/zero-people-search";

export async function callZeroPeopleSearch(
  body: ZeroPeopleSearchRequest,
): Promise<ZeroPeopleSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroPeopleSearchContract, config);
  const result = await client.search({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to search for people");
}
