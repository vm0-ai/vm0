import { eq, and } from "drizzle-orm";
import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import {
  connectorSessionByIdContract,
  connectorTypeSchema,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { connectorSessions } from "../../../../../../src/db/schema/connector-session";

const router = tsr.router(connectorSessionByIdContract, {
  get: async ({ params, headers }) => {
    initServices();

    // Validate connector type
    const typeResult = connectorTypeSchema.safeParse(params.type);
    if (!typeResult.success) {
      return createErrorResponse(
        "BAD_REQUEST",
        `Invalid connector type: ${params.type}`,
      );
    }
    const type = typeResult.data;

    // User must be authenticated
    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Authentication required");
    }

    const [session] = await globalThis.services.db
      .select()
      .from(connectorSessions)
      .where(
        and(
          eq(connectorSessions.id, params.sessionId),
          eq(connectorSessions.type, type),
          eq(connectorSessions.userId, userId),
        ),
      )
      .limit(1);

    if (!session) {
      return createErrorResponse("NOT_FOUND", "Connector session not found");
    }

    // Check if expired
    if (session.status === "pending" && new Date() > session.expiresAt) {
      // Update status to expired
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

const handler = createHandler(connectorSessionByIdContract, router);

export { handler as GET };
