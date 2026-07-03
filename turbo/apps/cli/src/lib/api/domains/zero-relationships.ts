import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  zeroRelationshipsContract,
  type RelationshipResolveResponse,
  type RelationshipSearchResponse,
} from "@vm0/api-contracts/contracts/zero-relationships";
import { getClientConfig, handleError } from "../core/client-factory";

export async function resolveZeroRelationship(
  options:
    | { readonly id: string; readonly email?: never; readonly domain?: never }
    | { readonly email: string; readonly id?: never; readonly domain?: never }
    | { readonly domain: string; readonly id?: never; readonly email?: never },
): Promise<RelationshipResolveResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroRelationshipsContract, config);
  const result = await client.resolve({ query: options });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to resolve relationship");
}

export async function searchZeroRelationships(options: {
  readonly q: string;
  readonly limit?: number;
}): Promise<RelationshipSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroRelationshipsContract, config);
  const result = await client.search({
    query: { q: options.q, limit: options.limit },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to search relationships");
}
