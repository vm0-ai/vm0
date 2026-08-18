import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import type { OrgResponse } from "@okouai/api-contracts/contracts/orgs";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * Get current org info via zero API
 */
export async function getOrg(): Promise<OrgResponse> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.get({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get organization");
}
