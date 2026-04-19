/**
 * Permission Access Requests API Handlers
 *
 * Mock handlers for /api/zero/permission-access-requests endpoints.
 */

import {
  permissionAccessRequestsListContract,
  type PermissionAccessRequestResponse,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockPermissionRequests: PermissionAccessRequestResponse[] = [];

export function setMockPermissionRequests(
  requests: PermissionAccessRequestResponse[],
): void {
  mockPermissionRequests = requests;
}

export function resetMockPermissionRequests(): void {
  mockPermissionRequests = [];
}

export const apiPermissionAccessRequestsHandlers = [
  mockApi(permissionAccessRequestsListContract.list, ({ respond }) => {
    return respond(200, mockPermissionRequests);
  }),
];
