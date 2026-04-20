/**
 * Org API Handlers
 *
 * Mock handlers for /api/zero/org endpoint (org API via zero layer).
 * Default behavior: user always has an org (for tests that need auth to work).
 */

import {
  zeroOrgContract,
  zeroOrgLeaveContract,
  zeroOrgDeleteContract,
  type OrgResponse,
} from "@vm0/core";
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
