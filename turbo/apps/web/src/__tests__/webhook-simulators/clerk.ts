import { vi } from "vitest";
import type { Mock } from "vitest";
import { NextRequest } from "next/server";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { POST } from "../../../app/api/webhooks/clerk/route";

/**
 * Clerk Webhook Simulator
 *
 * Simulates Clerk webhook events by mocking verifyWebhook and calling the
 * route handler directly. Consumer test files MUST declare:
 *
 *   vi.mock("@clerk/nextjs/webhooks", () => ({ verifyWebhook: vi.fn() }));
 *
 * at module level before importing these simulators.
 */

function createClerkWebhookRequest(): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

// Access the mock as a generic Mock to bypass Clerk's complex WebhookEvent
// union type. Test payloads only include fields the route handler reads.
function getVerifyWebhookMock(): Mock {
  return vi.mocked(verifyWebhook) as Mock;
}

export async function simulateClerkOrgCreated(
  orgId: string,
  orgName: string,
  slug: string,
): Promise<Response> {
  const event = {
    type: "organization.created",
    data: { id: orgId, name: orgName, slug, object: "organization" },
  };
  getVerifyWebhookMock().mockResolvedValueOnce(event);
  return POST(createClerkWebhookRequest());
}

export async function simulateClerkOrgDeleted(
  orgId: string,
): Promise<Response> {
  const event = {
    type: "organization.deleted",
    data: { id: orgId, object: "organization", deleted: true },
  };
  getVerifyWebhookMock().mockResolvedValueOnce(event);
  return POST(createClerkWebhookRequest());
}

export async function simulateClerkUserDeleted(
  userId: string,
): Promise<Response> {
  const event = {
    type: "user.deleted",
    data: { id: userId, object: "user", deleted: true },
  };
  getVerifyWebhookMock().mockResolvedValueOnce(event);
  return POST(createClerkWebhookRequest());
}
