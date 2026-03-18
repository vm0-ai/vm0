/**
 * PATCH /api/agent/composes/:id/metadata
 *
 * Update agent metadata (displayName, description, sound) directly
 * without triggering a compose job.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { canAccessCompose } from "../../../../../../src/lib/agent/compose-access";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";

const metadataUpdateSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  sound: z.string().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const authorization = request.headers.get("authorization") ?? undefined;
  const authResult = await requireAuth(authorization, {
    requiredCapability: "agent:write",
  });
  if (isAuthError(authResult)) {
    return NextResponse.json(authResult.body, { status: authResult.status });
  }
  const { userId } = authResult;

  const { id } = await params;

  // Validate request body
  const body = await request.json();
  const parsed = metadataUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { message: "Invalid request body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  // Get compose
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      userId: agentComposes.userId,
      orgId: agentComposes.orgId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, id))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Agent compose not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Check access
  const orgId = (await resolveOrg(authResult)).org.orgId;
  const hasAccess = canAccessCompose(userId, orgId, compose);
  if (!hasAccess) {
    return NextResponse.json(
      { error: { message: "Agent compose not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Upsert zero_agents with new metadata
  const update = parsed.data;
  await globalThis.services.db
    .insert(zeroAgents)
    .values({
      orgId: compose.orgId,
      name: compose.name,
      displayName: update.displayName ?? null,
      description: update.description ?? null,
      sound: update.sound ?? null,
    })
    .onConflictDoUpdate({
      target: [zeroAgents.orgId, zeroAgents.name],
      set: {
        ...(update.displayName !== undefined && {
          displayName: update.displayName,
        }),
        ...(update.description !== undefined && {
          description: update.description,
        }),
        ...(update.sound !== undefined && { sound: update.sound }),
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true });
}
