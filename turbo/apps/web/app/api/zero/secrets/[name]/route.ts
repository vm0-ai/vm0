import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroSecretsByNameContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { deleteSecret } from "../../../../../src/lib/zero/secret/secret-service";
import { logger } from "../../../../../src/lib/shared/logger";
import { isNotFound } from "../../../../../src/lib/shared/errors";

const log = logger("api:zero-secrets");

const router = tsr.router(zeroSecretsByNameContract, {
  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    log.debug("deleting secret", { userId, name: params.name });

    try {
      const { org } = await resolveOrg(authCtx);
      await deleteSecret(org.orgId, userId, params.name);

      return {
        status: 204 as const,
        body: undefined,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return createErrorResponse(
          "NOT_FOUND",
          `Secret "${params.name}" not found`,
        );
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroSecretsByNameContract, router, {
  routeName: "zero.secrets.byName",
});

export { handler as DELETE };
