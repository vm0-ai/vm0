import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import { orgContract } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { createOrganization } from "../../../src/lib/org/org-service";
import { isBadRequest } from "../../../src/lib/errors";

const router = tsr.router(orgContract, {
  create: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    try {
      const result = await createOrganization(userId, body.slug);

      return {
        status: 201 as const,
        body: {
          slug: result.scope.slug,
          role: result.role,
          members: [
            {
              userId,
              email: "",
              role: "admin" as const,
              joinedAt: result.scope.createdAt.toISOString(),
            },
          ],
          createdAt: result.scope.createdAt.toISOString(),
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return {
          status: 400 as const,
          body: {
            error: { message: error.message, code: "BAD_REQUEST" },
          },
        };
      }
      throw error;
    }
  },

  // Stub handlers for sub-routes (actual implementations are in separate files)
  status: async () => ({
    status: 404 as const,
    body: {
      error: { message: "Use /api/org/status", code: "NOT_FOUND" },
    },
  }),

  leave: async () => ({
    status: 404 as const,
    body: {
      error: { message: "Use /api/org/leave", code: "NOT_FOUND" },
    },
  }),

  invite: async () => ({
    status: 404 as const,
    body: {
      error: { message: "Use /api/org/invite", code: "NOT_FOUND" },
    },
  }),

  removeMember: async () => ({
    status: 404 as const,
    body: {
      error: { message: "Use /api/org/members", code: "NOT_FOUND" },
    },
  }),
});

const handler = createHandler(orgContract, router);

export { handler as POST };
