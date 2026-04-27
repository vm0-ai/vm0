import {
  zeroOrgContract,
  zeroOrgLeaveContract,
  zeroOrgDeleteContract,
} from "@vm0/api-contracts/contracts/zero-org";
import type { OrgResponse } from "@vm0/api-contracts/contracts/orgs";
import { http, HttpResponse } from "msw";
import { mockApi } from "../msw-contract.ts";

// Mock org data — default to admin role for development
let mockOrg: OrgResponse = {
  id: "org_1",
  slug: "user-12345678",
  name: "User 12345678",
  role: "admin",
};

let mockLogoUrl: string | null = null;

export function setMockOrg(overrides: Partial<OrgResponse>): void {
  mockOrg = { ...mockOrg, ...overrides };
}

export function resetMockOrg(): void {
  mockOrg = {
    id: "org_1",
    slug: "user-12345678",
    name: "User 12345678",
    role: "admin",
  };
}

export function setMockOrgLogo(logoUrl: string | null): void {
  mockLogoUrl = logoUrl;
}

export function resetMockOrgLogo(): void {
  mockLogoUrl = null;
}

export const apiOrgHandlers = [
  mockApi(zeroOrgContract.get, ({ respond }) => {
    return respond(200, mockOrg);
  }),

  mockApi(zeroOrgContract.update, ({ body, respond }) => {
    mockOrg = { ...mockOrg, ...body };
    return respond(200, mockOrg);
  }),

  mockApi(zeroOrgLeaveContract.leave, ({ respond }) => {
    return respond(200, { message: "Left org" });
  }),

  mockApi(zeroOrgDeleteContract.delete, ({ respond }) => {
    return respond(200, { message: "Org deleted" });
  }),

  http.get("*/api/zero/org/logo", () => {
    return HttpResponse.json({ logoUrl: mockLogoUrl });
  }),
];
