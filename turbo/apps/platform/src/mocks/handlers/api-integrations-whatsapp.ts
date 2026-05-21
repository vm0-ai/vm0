import {
  zeroIntegrationsWhatsAppContract,
  type WhatsAppLinkStatusResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-whatsapp";
import { mockApi } from "../msw-contract.ts";

let mockWhatsAppStatus: WhatsAppLinkStatusResponse = {
  linked: false,
  whatsAppNumber: "+19039853128",
  configured: true,
};

export function resetMockWhatsAppIntegration(): void {
  mockWhatsAppStatus = {
    linked: false,
    whatsAppNumber: "+19039853128",
    configured: true,
  };
}

export function setMockWhatsAppIntegration(
  status: WhatsAppLinkStatusResponse,
): void {
  mockWhatsAppStatus = structuredClone(status);
}

function normalizeWhatsAppHandle(value: string): string {
  return value.trim().replace(/[^\d+]/gu, "");
}

function isValidWhatsAppHandle(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}

export const apiIntegrationsWhatsAppHandlers = [
  mockApi(zeroIntegrationsWhatsAppContract.getLinkStatus, ({ respond }) => {
    return respond(200, mockWhatsAppStatus);
  }),

  mockApi(zeroIntegrationsWhatsAppContract.startLink, ({ body, respond }) => {
    const phoneHandle = normalizeWhatsAppHandle(body.phoneHandle);
    if (!isValidWhatsAppHandle(phoneHandle)) {
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

  mockApi(zeroIntegrationsWhatsAppContract.unlink, ({ respond }) => {
    mockWhatsAppStatus = {
      linked: false,
      whatsAppNumber: mockWhatsAppStatus.whatsAppNumber,
      configured: mockWhatsAppStatus.configured,
    };
    return respond(204);
  }),
];
