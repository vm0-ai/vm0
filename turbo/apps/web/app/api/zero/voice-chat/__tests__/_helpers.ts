import { NextRequest } from "next/server";
import { uniqueId } from "../../../../../src/__tests__/test-helpers";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import {
  createTestOrg,
  insertOrgDefaultModelProvider,
} from "../../../../../src/__tests__/db-test-seeders/org";
import {
  createTestComposeVersion,
  seedTestCompose,
} from "../../../../../src/__tests__/db-test-seeders/agents";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const BASE_URL = "http://localhost:3000/api/zero/voice-chat";

export async function setupVoiceChatOrg(userId: string): Promise<{
  orgId: string;
  slug: string;
}> {
  const slug = uniqueId("vcc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  // POST /:id/tasks tests spawn zero runs; createZeroRun asserts an org-default
  // model provider exists. Seeding here keeps per-test setup lean.
  await insertOrgDefaultModelProvider(
    orgId,
    "anthropic-api-key",
    "claude-3-5-sonnet-20241022",
  );
  return { orgId, slug };
}

export async function seedVoiceChatAgent(
  userId: string,
  orgId: string,
): Promise<{ agentId: string }> {
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-agent"),
  });
  // createZeroRun requires a head version; tests that spawn runs (POST tasks)
  // need this, and other tests don't care either way.
  await createTestComposeVersion(composeId, userId);
  return { agentId: composeId };
}

export async function seedVoiceChatSession(opts: {
  orgId: string;
  userId: string;
  agentId: string;
}): Promise<{ id: string }> {
  const { POST } = await import("../route");
  const response = await POST(postRequest("", { agentId: opts.agentId }));
  const body = (await response.json()) as { session: { id: string } };
  return { id: body.session.id };
}

export function postRequest(path: string, body?: unknown): NextRequest {
  return createTestRequest(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export function getRequest(path: string): NextRequest {
  return createTestRequest(`${BASE_URL}${path}`);
}

export function paramsFor(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}
