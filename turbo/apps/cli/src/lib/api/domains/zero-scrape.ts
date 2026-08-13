import {
  zeroScrapeContract,
  type ZeroScrapeRequest,
  type ZeroScrapeResponse,
} from "@okouai/api-contracts/contracts/zero-scrape";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

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
