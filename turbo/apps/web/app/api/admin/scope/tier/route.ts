import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { adminScopeTierContract, scopeTierSchema } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";
import {
  getScopeBySlug,
  isVm0Admin,
} from "../../../../../src/lib/scope/scope-service";
import { scopes } from "../../../../../src/db/schema/scope";
import { eq } from "drizzle-orm";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:admin:scope:tier");

const router = tsr.router(adminScopeTierContract, {
  setTier: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const email = await getUserEmail(userId);
    if (!isVm0Admin(email)) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Admin access required",
            code: "FORBIDDEN",
          },
        },
      };
    }

    const scope = await getScopeBySlug(body.slug);
    if (!scope) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Scope "${body.slug}" not found`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    log.debug(`Admin ${email} setting scope ${body.slug} tier to ${body.tier}`);

    const [updated] = await globalThis.services.db
      .update(scopes)
      .set({ tier: body.tier, updatedAt: new Date() })
      .where(eq(scopes.id, scope.id))
      .returning();

    return {
      status: 200 as const,
      body: {
        slug: updated!.slug,
        tier: scopeTierSchema.parse(updated!.tier),
        updatedAt: updated!.updatedAt.toISOString(),
      },
    };
  },
});

function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(adminScopeTierContract, router, {
  errorHandler,
});

export { handler as PUT };
