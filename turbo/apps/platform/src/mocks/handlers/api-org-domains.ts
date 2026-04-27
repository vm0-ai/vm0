/**
 * Org Domains API Handlers
 *
 * Mock handlers for /api/zero/org/domains endpoint.
 */

import { zeroOrgDomainsContract } from "@vm0/api-contracts/contracts/zero-org-domains";
import type { OrgDomain } from "@vm0/api-contracts/contracts/org-members";
import { mockApi } from "../msw-contract.ts";

let mockOrgDomains: OrgDomain[] = [];

export function setMockOrgDomains(domains: OrgDomain[]): void {
  mockOrgDomains = domains;
}

export function resetMockOrgDomains(): void {
  mockOrgDomains = [];
}

export const apiOrgDomainsHandlers = [
  mockApi(zeroOrgDomainsContract.list, ({ respond }) => {
    return respond(200, { domains: mockOrgDomains });
  }),
];
