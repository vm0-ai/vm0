import crypto from "crypto";
import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  connectorSessionsContract,
  connectorTypeSchema,
  createErrorResponse,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { connectorSessions } from "../../../../../src/db/schema/connector-session";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:connectors:sessions");

// Characters that are easy to read (excluding 0/O, 1/I/L)
const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateSessionCode(): string {
  const randomBytes = crypto.randomBytes(8);
  let code = "";

  for (let i = 0; i < 8; i++) {
    if (i === 4) code += "-";
    const byte = randomBytes[i];
    if (byte !== undefined) {
      code += CHARS[byte % CHARS.length];
    }
  }

  return code;
}

const router = tsr.router(connectorSessionsContract, {
  create: async ({ params, headers }) => {
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

    // User must be authenticated (CLI sends token in Authorization header)
    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Authentication required");
    }

    const code = generateSessionCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    const [session] = await globalThis.services.db
      .insert(connectorSessions)
      .values({
        code,
        type,
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

    log.debug("connector session created", {
      sessionId: session.id,
      type,
      code,
    });

    // Return verification path (CLI will construct full URL)
    const verificationUrl = `/api/connectors/${type}/authorize?session=${session.id}`;

    return {
      status: 200 as const,
      body: {
        id: session.id,
        code,
        type,
        status: "pending" as const,
        verificationUrl,
        expiresIn: 900, // 15 minutes in seconds
        interval: 5, // Poll every 5 seconds
      },
    };
  },
});

const handler = createHandler(connectorSessionsContract, router);

export { handler as POST };
