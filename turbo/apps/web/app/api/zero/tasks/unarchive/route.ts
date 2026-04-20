import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { unarchiveTask } from "../../../../../src/lib/zero/task/task-service";
import { taskTypeSchema } from "@vm0/core";

const bodySchema = z.object({
  taskId: z.string(),
  taskType: taskTypeSchema,
});

export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return Response.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const orgId = authCtx.orgId;
  if (!orgId) {
    return Response.json(
      { error: { message: "No organization selected", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: { message: "Invalid request body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const { taskId, taskType } = parsed.data;
  await unarchiveTask(authCtx.userId, orgId, taskId, taskType);

  return Response.json({ ok: true });
}
