import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { eq } from "drizzle-orm";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import {
  addPermission,
  removePermission,
  listPermissions,
} from "../../../../../../src/lib/agent/permission-service";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";

const addPermissionBodySchema = z
  .object({
    granteeType: z.enum(["public", "email"]),
    granteeEmail: z.string().email().nullish(),
  })
  .refine(
    (data) =>
      data.granteeType !== "email" ||
      (data.granteeEmail != null && data.granteeEmail !== ""),
    { message: "grantee_email required for email type" },
  );

const deletePermissionParamsSchema = z
  .object({
    type: z.enum(["public", "email"]),
    email: z.string().email().nullish(),
  })
  .refine(
    (data) =>
      data.type !== "email" || (data.email != null && data.email !== ""),
    { message: "email parameter required for email type" },
  );

// PostgreSQL error code 23505 = unique_violation
function isDuplicateKeyError(error: unknown): boolean {
  if (error instanceof Error) {
    // Check the error message
    if (error.message.includes("duplicate key value")) return true;
    // Check for PostgreSQL error code in cause
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    if (cause?.code === "23505") return true;
  }
  return false;
}

/**
 * GET /api/agent/composes/:id/permissions - List permissions
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const authorization = request.headers.get("authorization") ?? undefined;
  const userId = await getUserId(authorization);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { id } = await params;

  // Verify compose exists and user is owner
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, id))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Compose not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  if (compose.userId !== userId) {
    return NextResponse.json(
      {
        error: {
          message: "Only owner can view permissions",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  const permissions = await listPermissions(id);
  return NextResponse.json({ permissions });
}

/**
 * POST /api/agent/composes/:id/permissions - Add permission
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const authorization = request.headers.get("authorization") ?? undefined;
  const userId = await getUserId(authorization);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { id } = await params;
  const parseResult = addPermissionBodySchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parseResult.success) {
    const msg = parseResult.error.issues[0]?.message;
    const message =
      msg === "grantee_email required for email type"
        ? msg
        : "Invalid grantee_type";
    return NextResponse.json(
      { error: { message, code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const { granteeType, granteeEmail } = parseResult.data;

  // Verify compose exists and user is owner
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, id))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Compose not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  if (compose.userId !== userId) {
    return NextResponse.json(
      {
        error: {
          message: "Only owner can manage permissions",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  try {
    await addPermission(id, granteeType, userId, granteeEmail ?? undefined);
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    // Handle duplicate permission error (PostgreSQL error code 23505)
    if (isDuplicateKeyError(error)) {
      return NextResponse.json(
        { error: { message: "Permission already exists", code: "CONFLICT" } },
        { status: 409 },
      );
    }
    throw error;
  }
}

/**
 * DELETE /api/agent/composes/:id/permissions - Remove permission
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const authorization = request.headers.get("authorization") ?? undefined;
  const userId = await getUserId(authorization);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Unauthorized", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const parseResult = deletePermissionParamsSchema.safeParse({
    type: searchParams.get("type"),
    email: searchParams.get("email"),
  });
  if (!parseResult.success) {
    const msg = parseResult.error.issues[0]?.message;
    const message =
      msg === "email parameter required for email type"
        ? msg
        : "type parameter required";
    return NextResponse.json(
      { error: { message, code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }
  const { type: granteeType, email: granteeEmail } = parseResult.data;

  // Verify compose exists and user is owner
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, id))
    .limit(1);

  if (!compose) {
    return NextResponse.json(
      { error: { message: "Compose not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  if (compose.userId !== userId) {
    return NextResponse.json(
      {
        error: {
          message: "Only owner can manage permissions",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  const removed = await removePermission(
    id,
    granteeType,
    granteeEmail ?? undefined,
  );
  if (!removed) {
    return NextResponse.json(
      { error: { message: "Permission not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  return new NextResponse(null, { status: 204 });
}
