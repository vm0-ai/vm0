import { command } from "ccstate";
import { zeroReportErrorContract } from "@vm0/api-contracts/contracts/zero-report-error";

import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { submitZeroReportError$ } from "../services/zero-report-error.service";
import { safeAsync } from "../utils";
import type { RouteEntry } from "../route";

const log = logger("route:zero-report-error");

const runNotFound = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Run not found",
      code: "RUN_NOT_FOUND",
    }),
  }),
});

const forbidden = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Run does not belong to this organization",
      code: "FORBIDDEN",
    }),
  }),
});

const runNotFailed = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only failed runs can be reported",
      code: "RUN_NOT_FAILED",
    }),
  }),
});

const internalError = Object.freeze({
  status: 500 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Internal server error",
      code: "INTERNAL_ERROR",
    }),
  }),
});

const submitInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(bodyResultOf(zeroReportErrorContract.submit));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const submitted = await safeAsync(() => {
    return set(
      submitZeroReportError$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        ...bodyResult.data,
      },
      signal,
    );
  });
  signal.throwIfAborted();
  if ("error" in submitted) {
    log.warn("Failed to submit zero error report", {
      error: String(submitted.error),
    });
    return internalError;
  }

  const result = submitted.ok;

  if (result.kind === "run_not_found") {
    return runNotFound;
  }
  if (result.kind === "forbidden") {
    return forbidden;
  }
  if (result.kind === "run_not_failed") {
    return runNotFailed;
  }

  return { status: 200 as const, body: { reference: result.reference } };
});

export const zeroReportErrorRoutes: readonly RouteEntry[] = [
  {
    route: zeroReportErrorContract.submit,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent-run:read",
      },
      submitInner$,
    ),
  },
];
