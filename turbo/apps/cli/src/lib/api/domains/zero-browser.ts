import {
  zeroBrowserContract,
  type ZeroBrowserCreateRequest,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

async function client() {
  return initClient(zeroBrowserContract, await getClientConfig());
}

export async function createZeroBrowser(
  body: ZeroBrowserCreateRequest,
): Promise<{ browser: ZeroBrowserSession; cdpUrl: string }> {
  const result = await (await client()).create({ headers: {}, body });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to create a fresh managed browser");
}

export async function resumeZeroBrowser(): Promise<{
  browser: ZeroBrowserSession;
  cdpUrl: string;
}> {
  const result = await (
    await client()
  ).resume({
    headers: {},
    body: {},
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to resume the managed browser");
}

export async function getCurrentZeroBrowser(): Promise<ZeroBrowserSession> {
  const result = await (await client()).current({ headers: {} });
  if (result.status === 200) {
    return result.body.browser;
  }
  handleError(result, "Failed to get the current managed browser");
}
