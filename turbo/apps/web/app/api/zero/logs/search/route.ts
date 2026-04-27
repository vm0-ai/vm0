/**
 * Zero API - Logs Search Endpoint
 *
 * GET /api/zero/logs/search - Search agent events across runs
 */
import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroLogsSearchContract } from "@vm0/api-contracts/contracts/zero-runs";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { handleSearchLogs } from "../../../../../src/lib/infra/run/log-search-service";

const router = tsr.router(zeroLogsSearchContract, {
  searchLogs: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const body = await handleSearchLogs(userId, org.orgId, query);

    return { status: 200 as const, body };
  },
});

function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "queryError" in err) {
    const validationError = err as {
      queryError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.queryError?.issues[0]) {
      const issue = validationError.queryError.issues[0];
      const path = issue.path.join(".");
      const message = path ? `${path}: ${issue.message}` : issue.message;
      return TsRestResponse.fromJson(
        { error: { message, code: "BAD_REQUEST" } },
        { status: 400 },
      );
    }
  }

  return undefined;
}

const handler = createHandler(zeroLogsSearchContract, router, {
  routeName: "zero.logs.search",
  errorHandler,
});

export { handler as GET };
