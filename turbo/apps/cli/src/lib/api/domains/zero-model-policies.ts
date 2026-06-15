import { initClient } from "@ts-rest/core";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import type { OrgModelPoliciesResponse } from "@vm0/api-contracts/contracts/model-providers";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * List the current organization's model-first policies.
 */
export async function listZeroModelPolicies(): Promise<OrgModelPoliciesResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroModelPoliciesMainContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list model policies");
}
