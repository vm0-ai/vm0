import { initClient } from "@ts-rest/core";
import {
  zeroUserPreferencesContract,
  type UserPreferencesResponse,
} from "@vm0/api-contracts/contracts/zero-user-preferences";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * Get current user's preferences
 */
export async function getZeroUserPreferences(): Promise<UserPreferencesResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroUserPreferencesContract, config);

  const result = await client.get({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get user preferences");
}

/**
 * Update user preferences
 */
export async function updateZeroUserPreferences(body: {
  timezone?: string;
}): Promise<UserPreferencesResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroUserPreferencesContract, config);

  const result = await client.update({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to update user preferences");
}
