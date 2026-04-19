/**
 * Org Domains API Handlers
 *
 * Mock handlers for /api/zero/org/domains endpoint.
 */

import { zeroOrgDomainsContract, type OrgDomain } from "@vm0/core";
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
