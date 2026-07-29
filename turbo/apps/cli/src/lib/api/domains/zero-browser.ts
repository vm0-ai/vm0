import {
  zeroBrowserAuthorizationRequestsContract,
  zeroBrowserContract,
  type BrowserAuthorizationRequestCreateResponse,
  type ZeroBrowserCreateRequest,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

async function client() {
  return initClient(zeroBrowserContract, await getClientConfig());
}

async function authorizationClient() {
  return initClient(
    zeroBrowserAuthorizationRequestsContract,
    await getClientConfig(),
  );
}

export async function createBrowserAuthorizationRequest(): Promise<BrowserAuthorizationRequestCreateResponse> {
  const result = await (
    await authorizationClient()
  ).create({ headers: {}, body: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to create cloud browser authorization request");
}

export async function createZeroBrowser(
  body: ZeroBrowserCreateRequest,
): Promise<{ browser: ZeroBrowserSession; cdpUrl: string }> {
  const result = await (await client()).create({ headers: {}, body });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to create a new managed browser");
}

export async function useZeroBrowser(): Promise<{
  browser: ZeroBrowserSession;
  cdpUrl: string;
}> {
  const result = await (
    await client()
  ).use({
    headers: {},
    body: {},
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to open the managed browser");
}

export async function leaseZeroBrowser(): Promise<ZeroBrowserSession> {
  const result = await (
    await client()
  ).lease({
    headers: {},
    body: {},
  });
  if (result.status === 200) {
    return result.body.browser;
  }
  handleError(result, "Failed to extend the managed browser lease");
}

export async function getCurrentZeroBrowser(): Promise<ZeroBrowserSession> {
  const result = await (await client()).current({ headers: {} });
  if (result.status === 200) {
    return result.body.browser;
  }
  handleError(result, "Failed to get the current managed browser");
}
