import {
  permissionAccessRequestsListContract,
  type PermissionAccessRequestResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
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
