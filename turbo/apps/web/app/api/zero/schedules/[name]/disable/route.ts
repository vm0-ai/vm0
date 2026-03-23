import { z } from "zod";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { disableSchedule } from "../../../../../../src/lib/schedule";
import { isNotFound } from "../../../../../../src/lib/errors";

const bodySchema = z.object({ composeId: z.string() });

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
    const schedule = await disableSchedule(
      userId,
      orgId,
      parsed.data.composeId,
      name,
    );

    return Response.json(schedule, { status: 200 });
  } catch (error) {
    if (isNotFound(error)) {
      return Response.json(
        { error: { message: "Resource not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    throw error;
  }
}
