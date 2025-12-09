import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { cliAuthTokenContract } from "@vm0/core";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { deviceCodes } from "../../../../../src/db/schema/device-codes";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";

const router = tsr.router(cliAuthTokenContract, {
  exchange: async ({ body }) => {
    initServices();

    const { device_code } = body;

    const [session] = await globalThis.services.db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.code, device_code))
      .limit(1);

    if (!session) {
      return {
        status: 400 as const,
        body: {
          error: "invalid_request",
          error_description: "Invalid device code",
        },
      };
    }

    // Check if expired
    if (new Date() > session.expiresAt) {
      return {
        status: 400 as const,
        body: {
          error: "expired_token",
          error_description: "The device code has expired",
        },
      };
    }

    // Check status
    switch (session.status) {
      case "pending":
        return {
          status: 202 as const,
          body: {
            error: "authorization_pending",
            error_description:
              "The user has not yet completed authorization in the browser",
          },
        };

      case "denied": {
        // Clean up
        await globalThis.services.db
          .delete(deviceCodes)
          .where(eq(deviceCodes.code, device_code));

        return {
          status: 400 as const,
          body: {
            error: "access_denied",
            error_description: "The user denied the authorization request",
          },
        };
      }

      case "authenticated": {
        // Generate CLI token
        const randomBytes = crypto.randomBytes(32);
        const cliToken = `vm0_live_${randomBytes.toString("base64url")}`;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

        await globalThis.services.db.insert(cliTokens).values({
          token: cliToken,
          userId: session.userId as string,
          name: "CLI Device Flow Authentication",
          expiresAt,
          createdAt: now,
        });

        // Clean up device code
        await globalThis.services.db
          .delete(deviceCodes)
          .where(eq(deviceCodes.code, device_code));

        return {
          status: 200 as const,
          body: {
            access_token: cliToken,
            refresh_token: `refresh_${crypto.randomBytes(16).toString("hex")}`,
            token_type: "Bearer" as const,
            expires_in: 90 * 24 * 60 * 60, // 90 days in seconds
          },
        };
      }

      default:
        return {
          status: 500 as const,
          body: {
            error: "server_error",
            error_description: "Unknown device code status",
          },
        };
    }
  },
});

/**
 * Custom error handler to convert Zod validation errors to OAuth error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          {
            error: "invalid_request",
            error_description: `${issue.path.join(".")}: ${issue.message}`,
          },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createNextHandler(cliAuthTokenContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as POST };
