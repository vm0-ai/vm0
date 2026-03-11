import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-user-id";
import { enableSchedule } from "../../../../../../src/lib/schedule";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound, isSchedulePast } from "../../../../../../src/lib/errors";
import { resolveOrgId } from "../../../../../../src/lib/scope/scope-member-service";

const log = logger("api:schedules:enable");

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("Authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId, orgId: tokenOrgId } = authCtx;

  const { name } = await params;

  let body: { composeId: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid JSON body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  if (!body.composeId) {
    return NextResponse.json(
      { error: { message: "composeId is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const orgId = await resolveOrgId(userId, undefined, tokenOrgId);

  log.debug(`Enabling schedule ${name} for compose ${body.composeId}`);

  try {
    const schedule = await enableSchedule(userId, orgId, body.composeId, name);

    return NextResponse.json(schedule, { status: 200 });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (isSchedulePast(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "SCHEDULE_PAST" } },
        { status: 400 },
      );
    }
    throw error;
  }
}
