import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroSecretsContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  listSecrets,
  setSecret,
} from "../../../../src/lib/zero/secret/secret-service";
import { logger } from "../../../../src/lib/shared/logger";
import { isBadRequest } from "@vm0/api-services/errors";

const log = logger("api:zero-secrets");

const router = tsr.router(zeroSecretsContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);
    const secrets = await listSecrets(org.orgId, userId);

    return {
      status: 200 as const,
      body: {
        secrets: secrets.map((s) => {
          return {
            id: s.id,
            name: s.name,
            description: s.description,
            type: s.type,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
          };
        }),
      },
    };
  },

  set: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { name, value, description } = body;

    log.debug("setting secret", { userId, name });

    try {
      const { org } = await resolveOrg(authCtx);
      const secret = await setSecret(
        org.orgId,
        userId,
        name,
        value,
        description,
      );

      return {
        status: 200 as const,
        body: {
          id: secret.id,
          name: secret.name,
          description: secret.description,
          type: secret.type,
          createdAt: secret.createdAt.toISOString(),
          updatedAt: secret.updatedAt.toISOString(),
        },
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroSecretsContract, router, {
  routeName: "zero.secrets",
});

export { handler as GET, handler as POST };
