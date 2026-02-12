import { initClient } from "@ts-rest/core";
import {
  userPreferencesContract,
  type UserPreferencesResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * Get current user's preferences
 */
export async function getUserPreferences(): Promise<UserPreferencesResponse> {
  const config = await getClientConfig();
  const client = initClient(userPreferencesContract, config);

  const result = await client.get({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get user preferences");
}

/**
 * Update user preferences
 */
export async function updateUserPreferences(body: {
  timezone?: string;
  notifyEmail?: boolean;
  notifySlack?: boolean;
}): Promise<UserPreferencesResponse> {
  const config = await getClientConfig();
  const client = initClient(userPreferencesContract, config);

  const result = await client.update({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to update user preferences");
}
