import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import type { OrgResponse } from "@vm0/api-contracts/contracts/orgs";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * Get current org info via zero API
 */
export async function getZeroOrg(): Promise<OrgResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgContract, config);

  const result = await client.get({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get organization");
}
