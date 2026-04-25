import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { requireAdminPermission } from "../../../../src/lib/zero/require-agent-permission";
import {
  createCustomConnector,
  listCustomConnectorsWithSecretStatus,
} from "../../../../src/lib/zero/custom-connector/custom-connector-service";
import { isBadRequest } from "../../../../src/lib/shared/errors";

const router = tsr.router(zeroCustomConnectorsContract, {
  list: async ({ headers }) => {
    initServices();
    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;
    const { org } = await resolveOrg(authCtx);
    const connectors = await listCustomConnectorsWithSecretStatus(
      org.orgId,
      userId,
    );
    return {
      status: 200 as const,
      body: {
        connectors: connectors.map((c) => {
          return {
            id: c.id,
            slug: c.slug,
            displayName: c.displayName,
            prefixes: c.prefixes,
            headerName: c.headerName,
            headerTemplate: c.headerTemplate,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
            hasSecret: c.hasSecret,
          };
        }),
      },
    };
  },

  create: async ({ body, headers }) => {
    initServices();
    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;
    try {
      const { org, member } = await resolveOrg(authCtx);
      const forbidden = requireAdminPermission(
        member,
        "create custom connectors",
      );
      if (forbidden) return forbidden;
      const connector = await createCustomConnector(org.orgId, userId, body);
      return {
        status: 201 as const,
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
      throw error;
    }
  },
});

const handler = createHandler(zeroCustomConnectorsContract, router, {
  routeName: "zero.custom-connectors",
});

export { handler as GET, handler as POST };
