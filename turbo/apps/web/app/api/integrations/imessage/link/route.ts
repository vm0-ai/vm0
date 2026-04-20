import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-auth-context";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { verifyConnectSignature } from "../../../../../src/lib/zero/phone/imessage-connect-token";
import { sendIMessage } from "../../../../../src/lib/zero/phone/imessage-service";
import { getMemberRole } from "../../../../../src/lib/auth/org-membership-cache";
import { linkIMessageHandle } from "../../../../../src/lib/zero/phone/handlers/imessage-shared";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:imessage:link");

const linkBodySchema = z.object({
  handle: z.string().min(1),
  orgId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
});

/**
 * POST /api/integrations/imessage/link
 *
 * Bind an iMessage handle to the authenticated user's account.
 * The handle is globally unique — one phone number can only be bound to one org.
 */
export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const userId = await getUserId(authHeader ?? undefined);

  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const parseResult = linkBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      { error: { message: "Invalid request body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  // Verify the signed connect URL
  if (
    !verifyConnectSignature(
      body.handle,
      body.orgId,
      body.timestamp,
      body.signature,
    )
  ) {
    return NextResponse.json(
      {
        error: {
          message:
            "Invalid or expired connect link. Please send a new message to get a fresh link.",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Verify user is a member of the org
  const role = await getMemberRole(body.orgId, userId);
  if (!role) {
    return NextResponse.json(
      {
        error: {
          message: "You are not a member of this organization",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  // Link (or update) the handle, checking for cross-org conflicts
  const linkResult = await linkIMessageHandle(body.handle, body.orgId, userId);

  if (!linkResult.ok) {
    if (linkResult.conflict) {
      return NextResponse.json(
        {
          error: {
            message:
              "This iMessage account is already linked to another organization",
            code: "CONFLICT",
          },
        },
        { status: 409 },
      );
    }
  }

  log.info("iMessage handle linked", {
    handle: body.handle,
    orgId: body.orgId,
    userId,
  });

  // Send success message via iMessage (fire-and-forget after response).
  // The .catch() is intentional: a delivery failure must not roll back the
  // already-committed DB link or return an error to the caller.
  const [org] = await globalThis.services.db
    .select({ agentphoneAgentId: orgMetadata.agentphoneAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, body.orgId))
    .limit(1);

  if (org?.agentphoneAgentId) {
    after(
      sendIMessage({
        agentId: org.agentphoneAgentId,
        toNumber: body.handle,
        body: "Account linked successfully! You can now send messages directly to your agent.",
      }).catch((err: unknown) => {
        log.warn("Failed to send link success iMessage", { err });
      }),
    );
  }

  return NextResponse.json({ linked: true });
}
