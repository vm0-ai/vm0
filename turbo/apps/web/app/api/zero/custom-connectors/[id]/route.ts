import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  zeroCustomConnectorByIdContract,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { requireAdminPermission } from "../../../../../src/lib/zero/require-agent-permission";
import {
  deleteCustomConnector,
  patchCustomConnectorDisplayName,
} from "../../../../../src/lib/zero/custom-connector/custom-connector-service";
import { isBadRequest, isNotFound } from "../../../../../src/lib/shared/errors";

const router = tsr.router(zeroCustomConnectorByIdContract, {
  delete: async ({ params, headers }) => {
    initServices();
    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    try {
      const { org, member } = await resolveOrg(authCtx);
      const forbidden = requireAdminPermission(
        member,
        "delete custom connectors",
      );
      if (forbidden) return forbidden;
      await deleteCustomConnector(org.orgId, params.id);
      return { status: 204 as const, body: undefined };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Custom connector not found");
      }
      throw error;
    }
  },

  patch: async ({ params, body, headers }) => {
    initServices();
    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    try {
      const { org, member } = await resolveOrg(authCtx);
      const forbidden = requireAdminPermission(
        member,
        "rename custom connectors",
      );
      if (forbidden) return forbidden;
      const connector = await patchCustomConnectorDisplayName(
        org.orgId,
        params.id,
        body.displayName,
      );
      return {
        status: 200 as const,
        body: {
          id: connector.id,
          slug: connector.slug,
          displayName: connector.displayName,
          prefixes: connector.prefixes,
          headerName: connector.headerName,
          headerTemplate: connector.headerTemplate,
          createdAt: connector.createdAt.toISOString(),
          updatedAt: connector.updatedAt.toISOString(),
          hasSecret: false,
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse(
          "BAD_REQUEST",
          error instanceof Error ? error.message : "Invalid request",
        );
      }
      if (isNotFound(error)) {
        return createErrorResponse("NOT_FOUND", "Custom connector not found");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroCustomConnectorByIdContract, router, {
  routeName: "zero.custom-connectors.byId",
});

export { handler as DELETE, handler as PATCH };
