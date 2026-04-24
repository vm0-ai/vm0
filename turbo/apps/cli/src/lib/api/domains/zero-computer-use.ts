import { initClient } from "@ts-rest/core";
import {
  zeroComputerUseRegisterContract,
  zeroComputerUseUnregisterContract,
  zeroComputerUseHostContract,
} from "@vm0/core/contracts/zero-computer-use";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * Register a computer-use host (POST /api/zero/computer-use/register)
 */
export async function registerComputerUseHost(): Promise<{
  id: string;
  domain: string;
  token: string;
  ngrokToken: string;
  endpointPrefix: string;
}> {
  const config = await getClientConfig();
  const client = initClient(zeroComputerUseRegisterContract, config);

  const result = await client.register({});

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to register computer-use host");
}

/**
 * Unregister a computer-use host (DELETE /api/zero/computer-use/unregister)
 */
export async function unregisterComputerUseHost(): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroComputerUseUnregisterContract, config);

  const result = await client.unregister({});

  if (result.status === 204) {
    return;
  }

  handleError(result, "Failed to unregister computer-use host");
}

/**
 * Get the active computer-use host (GET /api/zero/computer-use/host)
 * Returns null if no active host exists (404)
 */
export async function getComputerUseHost(): Promise<{
  domain: string;
  token: string;
} | null> {
  const config = await getClientConfig();
  const client = initClient(zeroComputerUseHostContract, config);

  const result = await client.getHost({});

  if (result.status === 200) {
    return result.body;
  }

  if (result.status === 404) {
    return null;
  }

  handleError(result, "Failed to get computer-use host");
}
