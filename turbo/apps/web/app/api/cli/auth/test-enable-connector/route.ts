import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { connectorTypeSchema } from "@vm0/connectors/connectors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  resolveTestUserId,
  resolveTestUserOrg,
  DEFAULT_TEST_EMAIL,
} from "../../../../../src/lib/auth/test-user";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { isTestEndpointAllowed } from "../../../../../src/lib/auth/test-endpoint-guard";

const bodySchema = z.object({
  composeId: z.string().uuid("composeId must be a valid UUID"),
  connectorTypes: z.array(z.string()).min(1),
});

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
  if (!isTestEndpointAllowed(request)) {
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
  const org = await resolveTestUserOrg(userId);
  if (!org) {
    return NextResponse.json(
      { error: "Test user has no org — run test-token first" },
      { status: 400 },
    );
  }

  const db = globalThis.services.db;

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
