import {
  zeroIntegrationsAgentPhoneContract,
  type AgentPhoneLinkStatusResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { mockApi } from "../msw-contract.ts";

let mockAgentPhoneStatus: AgentPhoneLinkStatusResponse = {
  linked: false,
  agentPhoneNumber: "+19039853128",
  configured: true,
};

export function resetMockAgentPhoneIntegration(): void {
  mockAgentPhoneStatus = {
    linked: false,
    agentPhoneNumber: "+19039853128",
    configured: true,
  };
}

export function setMockAgentPhoneIntegration(
  status: AgentPhoneLinkStatusResponse,
): void {
  mockAgentPhoneStatus = structuredClone(status);
}

function normalizeAgentPhoneHandle(value: string): string {
  return value.trim().replace(/[^\d+]/gu, "");
}

function isValidAgentPhoneHandle(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}

export const apiIntegrationsAgentPhoneHandlers = [
  mockApi(zeroIntegrationsAgentPhoneContract.getLinkStatus, ({ respond }) => {
    return respond(200, mockAgentPhoneStatus);
  }),

  mockApi(zeroIntegrationsAgentPhoneContract.startLink, ({ body, respond }) => {
    const phoneHandle = normalizeAgentPhoneHandle(body.phoneHandle);
    if (!isValidAgentPhoneHandle(phoneHandle)) {
      return respond(400, {
        error: {
          message: "Enter a phone number with country code",
          code: "BAD_REQUEST",
        },
      });
    }
    return respond(200, {
      phoneHandle,
      verificationSent: true,
    });
  }),

  mockApi(zeroIntegrationsAgentPhoneContract.unlink, ({ respond }) => {
    mockAgentPhoneStatus = {
      linked: false,
      agentPhoneNumber: mockAgentPhoneStatus.agentPhoneNumber,
      configured: mockAgentPhoneStatus.configured,
    };
    return respond(204);
  }),
];
