import { and, eq } from "drizzle-orm";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { apiKeysByIdContract } from "@vm0/core/contracts/api-keys";
import { createErrorResponse } from "@vm0/core/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";

const router = tsr.router(apiKeysByIdContract, {
  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const deleted = await globalThis.services.db
      .delete(cliTokens)
      .where(
        and(eq(cliTokens.id, params.id), eq(cliTokens.userId, authCtx.userId)),
      )
      .returning({ id: cliTokens.id });

    if (deleted.length === 0) {
      return createErrorResponse("NOT_FOUND", "API key not found");
    }

    return {
      status: 204 as const,
      body: undefined,
    };
  },
});

const handler = createHandler(apiKeysByIdContract, router, {
  routeName: "zero.api-keys.byId",
  errorHandler: createSafeErrorHandler("zero-api-keys-by-id"),
});

export { handler as DELETE };
