import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import { orgContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import {
  createOrganization,
  getUserOwnedOrganization,
} from "../../../src/lib/org/org-service";
import { isBadRequest } from "../../../src/lib/errors";

const router = tsr.router(orgContract, {
  /**
   * POST /api/org - Create organization
   */
  create: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { slug } = body;

    try {
      const org = await createOrganization(userId, slug);

      return {
        status: 201 as const,
        body: {
          id: org.id,
          slug: org.slug,
          type: org.type,
          createdAt: org.createdAt.toISOString(),
          updatedAt: org.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        if (error.message.includes("already exists")) {
          return {
            status: 409 as const,
            body: {
              error: { message: error.message, code: "CONFLICT" },
            },
          };
        }
        return createErrorResponse("BAD_REQUEST", error.message);
      }
      throw error;
    }
  },

  /**
   * GET /api/org - Get user's owned organization
   */
  get: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const org = await getUserOwnedOrganization(userId);
    if (!org) {
      return createErrorResponse(
        "NOT_FOUND",
        "You don't have an organization. Create one with: vm0 scope org create <slug>",
      );
    }

    return {
      status: 200 as const,
      body: {
        id: org.id,
        slug: org.slug,
        type: org.type,
        createdAt: org.createdAt.toISOString(),
        updatedAt: org.updatedAt.toISOString(),
      },
    };
  },

  // Stub handlers for routes in sub-paths (handled by their own route files)
  status: async () => {
    return createErrorResponse("NOT_FOUND", "Use /api/org/status endpoint");
  },
  createInvite: async () => {
    return createErrorResponse("NOT_FOUND", "Use /api/org/invite endpoint");
  },
  removeMember: async () => {
    return createErrorResponse(
      "NOT_FOUND",
      "Use /api/org/members/:userId endpoint",
    );
  },
  leave: async () => {
    return createErrorResponse("NOT_FOUND", "Use /api/org/leave endpoint");
  },
});

const handler = createHandler(orgContract, router);

export { handler as GET, handler as POST };
