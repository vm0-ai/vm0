import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { enableSchedule } from "../../../../../../src/lib/schedule";
import { logger } from "../../../../../../src/lib/logger";
import {
  NotFoundError,
  SchedulePastError,
} from "../../../../../../src/lib/errors";

const log = logger("api:schedules:enable");

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  initServices();

  const userId = await getUserId(
    request.headers.get("Authorization") ?? undefined,
  );
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

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

  log.debug(`Enabling schedule ${name} for compose ${body.composeId}`);

  try {
    const schedule = await enableSchedule(userId, body.composeId, name);

    return NextResponse.json(schedule, { status: 200 });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return NextResponse.json(
        { error: { message: error.message, code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (error instanceof SchedulePastError) {
      return NextResponse.json(
        { error: { message: error.message, code: "SCHEDULE_PAST" } },
        { status: 400 },
      );
    }
    throw error;
  }
}
