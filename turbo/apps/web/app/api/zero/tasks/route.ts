import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { tasksContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import {
  listTasks,
  archiveTask,
  unarchiveTask,
} from "../../../../src/lib/zero/task/task-service";
import { publishUserSignal } from "../../../../src/lib/infra/realtime/client";
import { getOrgMemberUserIds } from "../../../../src/lib/infra/realtime/audience";
import { after } from "next/server";

const router = tsr.router(tasksContract, {
  list: async ({ query, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const orgId = authCtx.orgId;
    if (!orgId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "No organization selected", code: "UNAUTHORIZED" },
        },
      };
    }

    const tasks = await listTasks(authCtx.userId, orgId, query.agentId);

    return {
      status: 200 as const,
      body: { tasks },
    };
  },

  archive: async ({ body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const orgId = authCtx.orgId;
    if (!orgId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "No organization selected", code: "UNAUTHORIZED" },
        },
      };
    }

    await archiveTask(
      authCtx.userId,
      orgId,
      body.taskId,
      body.taskType,
      body.runId,
    );

    // Notify org members that task list changed
    after(async () => {
      const members = await getOrgMemberUserIds(orgId);
      await publishUserSignal(members, `tasks:${orgId}`);
    });

    return { status: 200 as const, body: { ok: true as const } };
  },

  unarchive: async ({ body, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const orgId = authCtx.orgId;
    if (!orgId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "No organization selected", code: "UNAUTHORIZED" },
        },
      };
    }

    await unarchiveTask(authCtx.userId, orgId, body.taskId, body.taskType);

    // Notify org members that task list changed
    after(async () => {
      const members = await getOrgMemberUserIds(orgId);
      await publishUserSignal(members, `tasks:${orgId}`);
    });

    return { status: 200 as const, body: { ok: true as const } };
  },
});

const handler = createHandler(tasksContract, router, {
  errorHandler: createSafeErrorHandler("zero-tasks"),
});

export { handler as GET, handler as POST };
