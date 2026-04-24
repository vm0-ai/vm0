import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroConnectorSessionsContract } from "@vm0/core/contracts/zero-connectors";
import { createErrorResponse } from "@vm0/core/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { connectorSessions } from "../../../../../../src/db/schema/connector-session";
import { generateCode } from "../../../../../../src/lib/shared/crypto";

const router = tsr.router(zeroConnectorSessionsContract, {
  create: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    const [session] = await globalThis.services.db
      .insert(connectorSessions)
      .values({
        code,
        type: params.type,
        userId,
        status: "pending",
        expiresAt,
      })
      .returning();

    if (!session) {
      return createErrorResponse(
        "INTERNAL_SERVER_ERROR",
        "Failed to create connector session",
      );
    }

    const verificationUrl = `/api/connectors/${params.type}/authorize?session=${session.id}`;

    return {
      status: 200 as const,
      body: {
        id: session.id,
        code,
        type: params.type,
        status: "pending" as const,
        verificationUrl,
        expiresIn: 900, // 15 minutes in seconds
        interval: 5, // Poll every 5 seconds
      },
    };
  },
});

const handler = createHandler(zeroConnectorSessionsContract, router, {
  routeName: "zero.connectors.sessions",
});

export { handler as POST };
