import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { connectorTypeSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  resolveTestUserId,
  DEFAULT_TEST_EMAIL,
} from "../../../../../src/lib/auth/test-user";
import { orgMembersCache } from "../../../../../src/db/schema/org-members-cache";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { userConnectors } from "../../../../../src/db/schema/user-connector";
import { getOrgMetadata } from "../../../../../src/lib/zero/org/org-metadata-service";
import { isNotFound } from "../../../../../src/lib/shared/errors";
import { env } from "../../../../../src/env";

const bodySchema = z.object({
  composeId: z.string().uuid("composeId must be a valid UUID"),
  connectorTypes: z.array(z.string()).min(1),
});

/**
 * Check if test endpoint is allowed (same guard as test-connector).
 */
function isAllowed(request: Request): boolean {
  const vercelEnv = env().VERCEL_ENV;
  const nodeEnv = env().NODE_ENV;

  if (!vercelEnv && nodeEnv === "development") {
    return true;
  }

  if (vercelEnv === "preview") {
    const bypassHeader = request.headers.get("x-vercel-protection-bypass");
    const expectedSecret = env().VERCEL_AUTOMATION_BYPASS_SECRET;
    return !!expectedSecret && bypassHeader === expectedSecret;
  }

  return false;
}

/**
 * POST /api/cli/auth/test-enable-connector
 *
 * Test-only endpoint to enable connectors for an agent WITHOUT linking them.
 * Creates user_connectors entries so firewalls are injected at runtime,
 * but does NOT create OAuth/API-token records — secrets will be missing.
 *
 * Body: { composeId: string, connectorTypes: string[] }
 * Query: ?email=<email>
 */
export async function POST(request: Request) {
  if (!isAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  initServices();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "composeId and connectorTypes are required" },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const invalidTypes = body.connectorTypes.filter((t) => {
    return !connectorTypeSchema.safeParse(t).success;
  });
  if (invalidTypes.length > 0) {
    return NextResponse.json(
      { error: `Unknown connector types: ${invalidTypes.join(", ")}` },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email") ?? DEFAULT_TEST_EMAIL;
  const userId = await resolveTestUserId(email);

  const db = globalThis.services.db;

  // Look up test user's org
  const [cached] = await db
    .select({ orgId: orgMembersCache.orgId })
    .from(orgMembersCache)
    .where(eq(orgMembersCache.userId, userId))
    .orderBy(desc(orgMembersCache.cachedAt))
    .limit(1);

  let org: { orgId: string; tier: string } | null = null;
  if (cached) {
    try {
      org = await getOrgMetadata(cached.orgId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      org = { orgId: cached.orgId, tier: "free" };
    }
  }
  if (!org) {
    return NextResponse.json(
      { error: "Test user has no org — run test-token first" },
      { status: 400 },
    );
  }

  // Ensure zeroAgents record exists (user_connectors has FK to it)
  const [compose] = await db
    .select({
      id: agentComposes.id,
      orgId: agentComposes.orgId,
      userId: agentComposes.userId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, body.composeId))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: `Compose not found: ${body.composeId}` },
      { status: 404 },
    );
  }

  await db
    .insert(zeroAgents)
    .values({
      id: compose.id,
      orgId: compose.orgId,
      owner: compose.userId,
      name: compose.name,
    })
    .onConflictDoNothing();

  // Insert user_connectors entries
  await db.insert(userConnectors).values(
    body.connectorTypes.map((connectorType) => {
      return {
        orgId: org.orgId,
        userId,
        agentId: compose.id,
        connectorType,
      };
    }),
  );

  return NextResponse.json({
    ok: true,
    composeId: body.composeId,
    connectorTypes: body.connectorTypes,
  });
}
