import {
  zeroSeoContract,
  type ZeroSeoBacklinksSummaryRequest,
  type ZeroSeoKeywordIdeasRequest,
  type ZeroSeoRankedKeywordsRequest,
  type ZeroSeoResponse,
  type ZeroSeoSerpRequest,
} from "@vm0/api-contracts/contracts/zero-seo";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export async function callZeroSeoSerp(
  body: ZeroSeoSerpRequest,
): Promise<ZeroSeoResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSeoContract, config);
  const result = await client.serp({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch SEO search results");
}

export async function callZeroSeoKeywordIdeas(
  body: ZeroSeoKeywordIdeasRequest,
): Promise<ZeroSeoResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSeoContract, config);
  const result = await client.keywordIdeas({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch SEO keyword ideas");
}

export async function callZeroSeoRankedKeywords(
  body: ZeroSeoRankedKeywordsRequest,
): Promise<ZeroSeoResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSeoContract, config);
  const result = await client.rankedKeywords({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch ranked keywords");
}

export async function callZeroSeoBacklinksSummary(
  body: ZeroSeoBacklinksSummaryRequest,
): Promise<ZeroSeoResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroSeoContract, config);
  const result = await client.backlinksSummary({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch the backlinks summary");
}
