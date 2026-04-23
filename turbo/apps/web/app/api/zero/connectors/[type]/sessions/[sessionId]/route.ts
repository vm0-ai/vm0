import { eq, and } from "drizzle-orm";
import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { zeroConnectorSessionByIdContract } from "@vm0/core/contracts/zero-connectors";
import { createErrorResponse } from "@vm0/core/contracts/errors";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../../src/lib/auth/require-auth";
import { connectorSessions } from "../../../../../../../src/db/schema/connector-session";

const router = tsr.router(zeroConnectorSessionByIdContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const [session] = await globalThis.services.db
      .select()
      .from(connectorSessions)
      .where(
        and(
          eq(connectorSessions.id, params.sessionId),
          eq(connectorSessions.type, params.type),
          eq(connectorSessions.userId, userId),
        ),
      )
      .limit(1);

    if (!session) {
      return createErrorResponse("NOT_FOUND", "Connector session not found");
    }

    // Check if expired
    if (session.status === "pending" && new Date() > session.expiresAt) {
      await globalThis.services.db
        .update(connectorSessions)
        .set({ status: "expired" })
        .where(eq(connectorSessions.id, session.id));

      return {
        status: 200 as const,
        body: {
          status: "expired" as const,
          errorMessage: "Session has expired",
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        status: session.status,
        errorMessage: session.errorMessage,
      },
    };
  },
});

const handler = createHandler(zeroConnectorSessionByIdContract, router, {
  routeName: "zero.connectors.sessions.bySessionId",
});

export { handler as GET };
