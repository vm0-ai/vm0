import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  orgModelProvidersByTypeContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { deleteOrgModelProvider } from "../../../../../src/lib/model-provider/model-provider-service";
import { logger } from "../../../../../src/lib/logger";
import { isNotFound } from "../../../../../src/lib/errors";

const log = logger("api:org-model-providers");

const router = tsr.router(orgModelProvidersByTypeContract, {
  /**
   * DELETE /api/org/model-providers/:type - Delete an org-level model provider
   * Admin only.
   */
  delete: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(userId, orgSlug);

    if (member.role !== "admin") {
      return createErrorResponse(
        "FORBIDDEN",
        "Only admins can manage org model providers",
      );
    }

    log.debug("deleting org model provider", {
      orgId: org.orgId,
      type: params.type,
    });

    try {
      await deleteOrgModelProvider(org.orgId, params.type);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Resource not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(orgModelProvidersByTypeContract, router);

export { handler as DELETE };
