import {
  zeroScrapeContract,
  type ZeroScrapeRequest,
  type ZeroScrapeResponse,
} from "@vm0/api-contracts/contracts/zero-scrape";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export type { ZeroScrapeResponse } from "@vm0/api-contracts/contracts/zero-scrape";

export async function callZeroScrape(
  body: ZeroScrapeRequest,
): Promise<ZeroScrapeResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroScrapeContract, config);

  const result = await client.scrape({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to scrape page");
}
