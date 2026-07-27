import {
  zeroFinanceContract,
  type ZeroFinanceChartRequest,
  type ZeroFinanceProfileRequest,
  type ZeroFinanceQuoteRequest,
  type ZeroFinanceResponse,
  type ZeroFinanceSearchRequest,
} from "@vm0/api-contracts/contracts/zero-finance";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

export type { ZeroFinanceResponse } from "@vm0/api-contracts/contracts/zero-finance";

export async function callZeroFinanceSearch(
  body: ZeroFinanceSearchRequest,
): Promise<ZeroFinanceResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroFinanceContract, config);
  const result = await client.search({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to search financial instruments");
}

export async function callZeroFinanceProfile(
  body: ZeroFinanceProfileRequest,
): Promise<ZeroFinanceResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroFinanceContract, config);
  const result = await client.profile({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch finance profile");
}

export async function callZeroFinanceQuote(
  body: ZeroFinanceQuoteRequest,
): Promise<ZeroFinanceResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroFinanceContract, config);
  const result = await client.quote({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch finance quote");
}

export async function callZeroFinanceChart(
  body: ZeroFinanceChartRequest,
): Promise<ZeroFinanceResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroFinanceContract, config);
  const result = await client.chart({ headers: {}, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to fetch finance chart");
}
