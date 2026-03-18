import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-auth-context";
import { getUserAccessibleOrgs } from "../../../../src/lib/org/org-member-service";

export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const userId = await getUserId(authHeader);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const orgs = await getUserAccessibleOrgs(userId);

  return NextResponse.json({
    orgs,
    active: undefined,
  });
}
