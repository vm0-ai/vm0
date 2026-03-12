import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-user-id";
import { disableSchedule } from "../../../../../../src/lib/schedule";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound } from "../../../../../../src/lib/errors";
import { resolveOrgId } from "../../../../../../src/lib/scope/scope-member-service";

const log = logger("api:schedules:disable");

const disableScheduleBodySchema = z.object({
  composeId: z.string().uuid(),
});

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

  const parseResult = disableScheduleBodySchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: {
          message: "composeId must be a valid UUID",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const body = parseResult.data;

  const orgId = await resolveOrgId(userId, undefined, tokenOrgId);

  log.debug(`Disabling schedule ${name} for compose ${body.composeId}`);

  try {
    const schedule = await disableSchedule(userId, orgId, body.composeId, name);

    return NextResponse.json(schedule, { status: 200 });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    throw error;
  }
}
