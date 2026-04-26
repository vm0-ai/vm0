import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import {
  isBadRequest,
  isForbidden,
  isNotFound,
} from "@vm0/api-services/errors";

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function errorJson(message: string, status: number) {
  return NextResponse.json(
    {
      error: { message, code: status === 401 ? "UNAUTHORIZED" : "BAD_REQUEST" },
    },
    { status },
  );
}

/**
 * GET /api/zero/org/logo — get current org logo URL from Clerk
 */
export async function GET(request: NextRequest) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return errorJson("Not authenticated", 401);

  try {
    const { org: resolvedOrg } = await resolveOrg(authCtx);

    const client = await clerkClient();
    const clerkOrg = await client.organizations.getOrganization({
      organizationId: resolvedOrg.orgId,
    });

    return NextResponse.json({
      logoUrl: clerkOrg.imageUrl || null,
      hasImage: clerkOrg.hasImage,
    });
  } catch (error) {
    if (isBadRequest(error) || isNotFound(error)) {
      return errorJson("Org not found", 404);
    }
    throw error;
  }
}

/**
 * POST /api/zero/org/logo — upload org logo via Clerk (admin only)
 */
export async function POST(request: NextRequest) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return errorJson("Not authenticated", 401);

  try {
    const { org: resolvedOrg, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return errorJson("Only admins can upload the logo", 403);
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return errorJson("No file provided", 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return errorJson("File too large (max 2 MB)", 400);
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return errorJson(`Unsupported file type: ${file.type}`, 400);
    }

    const client = await clerkClient();
    const updatedOrg = await client.organizations.updateOrganizationLogo(
      resolvedOrg.orgId,
      { file },
    );

    return NextResponse.json({
      logoUrl: updatedOrg.imageUrl || null,
      hasImage: updatedOrg.hasImage,
    });
  } catch (error) {
    if (isBadRequest(error) || isNotFound(error)) {
      return errorJson("Org not found", 404);
    }
    if (isForbidden(error)) {
      return errorJson("Access denied", 403);
    }
    throw error;
  }
}

/**
 * DELETE /api/zero/org/logo — remove org logo via Clerk (admin only)
 */
export async function DELETE(request: NextRequest) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) return errorJson("Not authenticated", 401);

  try {
    const { org: resolvedOrg, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return errorJson("Only admins can remove the logo", 403);
    }

    const client = await clerkClient();
    const updatedOrg = await client.organizations.deleteOrganizationLogo(
      resolvedOrg.orgId,
    );

    return NextResponse.json({
      logoUrl: updatedOrg.imageUrl || null,
      hasImage: updatedOrg.hasImage,
    });
  } catch (error) {
    if (isBadRequest(error) || isNotFound(error)) {
      return errorJson("Org not found", 404);
    }
    if (isForbidden(error)) {
      return errorJson("Access denied", 403);
    }
    throw error;
  }
}
