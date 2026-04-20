/**
 * Phone API Handlers
 *
 * Mock handlers for /api/zero/phone endpoints.
 * Default behavior: no phone numbers linked.
 */

import {
  zeroPhoneStatusContract,
  zeroPhoneLinkContract,
  zeroPhoneSetupContract,
  type PhoneStatusResponse,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

const DEFAULT_PHONE_STATUS: PhoneStatusResponse = {
  userPhone: null,
  userPhonePending: null,
  orgPhone: null,
};

let mockPhoneStatus: PhoneStatusResponse = { ...DEFAULT_PHONE_STATUS };

export function setMockPhoneStatus(status: Partial<PhoneStatusResponse>): void {
  mockPhoneStatus = { ...mockPhoneStatus, ...status };
}

export function resetMockPhoneStatus(): void {
  mockPhoneStatus = { ...DEFAULT_PHONE_STATUS };
}

export const apiPhoneHandlers = [
  // GET /api/zero/phone/status
  mockApi(zeroPhoneStatusContract.getStatus, ({ respond }) =>
    respond(200, mockPhoneStatus),
  ),

  // POST /api/zero/phone/link
  mockApi(zeroPhoneLinkContract.link, ({ respond }) =>
    respond(200, { success: true }),
  ),

  // DELETE /api/zero/phone/link
  mockApi(zeroPhoneLinkContract.unlink, ({ respond }) =>
    respond(200, { success: true }),
  ),

  // POST /api/zero/phone/setup
  mockApi(zeroPhoneSetupContract.setup, ({ respond }) =>
    respond(200, {
      phoneNumber: "+18001234567",
      agentId: "c0000000-0000-4000-a000-000000000001",
    }),
  ),
];
