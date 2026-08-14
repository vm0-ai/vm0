import {
  scrapeContract,
  type ScrapeRequest,
  type ScrapeResponse,
} from "@okouai/api-contracts/contracts/scrape";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callScrape(body: ScrapeRequest): Promise<ScrapeResponse> {
  const config = await getClientConfig();
  const client = initClient(scrapeContract, config);

  const result = await client.scrape({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to scrape page");
}
