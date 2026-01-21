import { initClient } from "@ts-rest/core";
import { scopeContract } from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";
import type { ScopeResponse } from "../core/types";

/**
 * Get current user's scope
 */
export async function getScope(): Promise<ScopeResponse> {
  const config = await getClientConfig();
  const client = initClient(scopeContract, config);

  const result = await client.get();

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get scope");
}

/**
 * Create user's scope
 */
export async function createScope(body: {
  slug: string;
  displayName?: string;
}): Promise<ScopeResponse> {
  const config = await getClientConfig();
  const client = initClient(scopeContract, config);

  const result = await client.create({ body });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create scope");
}

/**
 * Update user's scope slug
 */
export async function updateScope(body: {
  slug: string;
  force?: boolean;
}): Promise<ScopeResponse> {
  const config = await getClientConfig();
  const client = initClient(scopeContract, config);

  const result = await client.update({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to update scope");
}
