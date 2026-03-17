import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { enableSchedule } from "../../../../../../src/lib/schedule";
import { logger } from "../../../../../../src/lib/logger";
import { isNotFound, isSchedulePast } from "../../../../../../src/lib/errors";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";

const log = logger("api:schedules:enable");

const enableScheduleBodySchema = z.object({
  composeId: z.uuid(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  initServices();

  const authCtx = await requireAuth(
    request.headers.get("Authorization") ?? undefined,
    { requiredCapability: "schedule:write" },
  );
  if (isAuthError(authCtx)) {
    return NextResponse.json(authCtx.body, { status: authCtx.status });
  }
  const { userId } = authCtx;

  const { name } = await params;

  const parseResult = enableScheduleBodySchema.safeParse(
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

  const orgSlug = new URL(request.url).searchParams.get("org");
  const {
    org: { orgId },
  } = await resolveOrg(authCtx, orgSlug);

  log.debug(`Enabling schedule ${name} for compose ${body.composeId}`);

  try {
    const schedule = await enableSchedule(userId, orgId, body.composeId, name);

    return NextResponse.json(schedule, { status: 200 });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json(
        { error: { message: "Resource not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (isSchedulePast(error)) {
      return NextResponse.json(
        {
          error: {
            message: "Schedule time has already passed",
            code: "SCHEDULE_PAST",
          },
        },
        { status: 400 },
      );
    }
    throw error;
  }
}
