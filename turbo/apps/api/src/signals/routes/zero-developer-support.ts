import { command } from "ccstate";
import { zeroDeveloperSupportContract } from "@vm0/api-contracts/contracts/zero-developer-support";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { submitZeroDeveloperSupport$ } from "../services/zero-developer-support.service";
import type { RouteEntry } from "../route";

const scopedZeroTokenRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "This endpoint requires a zero token with runId and orgId",
      code: "FORBIDDEN",
    }),
  }),
});

const runNotFound = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Run not found",
      code: "RUN_NOT_FOUND",
    }),
  }),
});

const invalidConsentCode = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Invalid consent code",
      code: "INVALID_CONSENT_CODE",
    }),
  }),
});

const submitInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const bodyResult = await get(
    bodyResultOf(zeroDeveloperSupportContract.submit),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const runId = "runId" in auth ? auth.runId : undefined;
  const orgId = "orgId" in auth ? auth.orgId : undefined;

  if (!runId || !orgId) {
    return scopedZeroTokenRequired;
  }

  const result = await set(
    submitZeroDeveloperSupport$,
    {
      userId: auth.userId,
      orgId,
      runId,
      ...bodyResult.data,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "run_not_found") {
    return runNotFound;
  }
  if (result.kind === "invalid_consent_code") {
    return invalidConsentCode;
  }
  if (result.kind === "consent_code") {
    return { status: 200 as const, body: { consentCode: result.consentCode } };
  }

  return { status: 200 as const, body: { reference: result.reference } };
});

export const zeroDeveloperSupportRoutes: readonly RouteEntry[] = [
  {
    route: zeroDeveloperSupportContract.submit,
    handler: authRoute({ acceptAnySandboxCapability: true }, submitInner$),
  },
];
