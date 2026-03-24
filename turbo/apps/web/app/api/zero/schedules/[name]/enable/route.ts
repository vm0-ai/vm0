import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { enableSchedule } from "../../../../../../src/lib/schedule";
import { isNotFound, isSchedulePast } from "../../../../../../src/lib/errors";

const bodySchema = z
  .object({
    zeroAgentId: z.string().optional(),
    composeId: z.string().optional(),
  })
  .refine((data) => Boolean(data.zeroAgentId ?? data.composeId), {
    message: "Either 'zeroAgentId' or 'composeId' must be provided",
  });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  initServices();

  const { name } = await params;
  const authorization = request.headers.get("authorization") ?? undefined;

  const authCtx = await requireAuth(authorization, {
    requiredCapability: "schedule:write",
  });
  if (isAuthError(authCtx)) {
    return Response.json(authCtx.body, { status: authCtx.status });
  }
  const { userId } = authCtx;

  const orgSlug = new URL(request.url).searchParams.get("org");
  const {
    org: { orgId },
  } = await resolveOrg(authCtx, orgSlug);

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: { message: "Invalid request body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  try {
    const resolvedAgentId = parsed.data.zeroAgentId ?? parsed.data.composeId;
    if (!resolvedAgentId) throw new Error("Missing agent ID after validation");
    const schedule = await enableSchedule(userId, orgId, resolvedAgentId, name);

    return Response.json(schedule, { status: 200 });
  } catch (error) {
    if (isNotFound(error)) {
      return Response.json(
        { error: { message: "Resource not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    if (isSchedulePast(error)) {
      return Response.json(
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
