import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { zeroImageIoInterpretMarksContract } from "@vm0/api-contracts/contracts/zero-image-io-interpret-marks";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { isLlmConfigured } from "../external/openrouter";
import type { RouteEntry } from "../route-entry";
import { insufficientCredits, notConfigured } from "../../lib/error";
import { checkBillableOperationCredits$ } from "../services/billable-operation-admission.service";
import {
  checkOpenRouterUsagePricing$,
  recordOpenRouterUsage$,
} from "../services/openrouter-usage.service";
import {
  INTERPRET_MARKS_MODEL,
  interpretRegionMarks,
} from "../services/zero-image-interpret-marks.service";

const interpretMarksBody$ = bodyResultOf(
  zeroImageIoInterpretMarksContract.post,
);

// Compatibility for browser bundles shipped before image editing was retired.
// Remove this route after the frontend rollout and rollback window complete.
const postInterpretMarksInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);

    const bodyResult = await get(interpretMarksBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const shouldCallModel = isLlmConfigured();
    if (shouldCallModel) {
      const hasCredits = await set(
        checkBillableOperationCredits$,
        { orgId: auth.orgId },
        signal,
      );
      signal.throwIfAborted();
      if (!hasCredits) {
        return insufficientCredits();
      }

      const missingPricing = await set(
        checkOpenRouterUsagePricing$,
        { provider: INTERPRET_MARKS_MODEL },
        signal,
      );
      signal.throwIfAborted();
      if (missingPricing.length > 0) {
        return notConfigured(
          "Image mark interpretation pricing is not configured",
        );
      }
    }

    const operationId = randomUUID();
    const result = await interpretRegionMarks({
      imageUrl: bodyResult.data.imageUrl,
      regions: bodyResult.data.regions,
    });
    signal.throwIfAborted();

    if (result.usage) {
      await set(
        recordOpenRouterUsage$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          runId: "runId" in auth ? auth.runId : undefined,
          provider: INTERPRET_MARKS_MODEL,
          operation: "image-interpret-marks",
          operationId,
          usage: result.usage,
        },
        signal,
      );
      signal.throwIfAborted();
    }

    return { status: 200 as const, body: { regions: result.regions } };
  },
);

export const zeroImageIoInterpretMarksRoutes: readonly RouteEntry[] = [
  {
    route: zeroImageIoInterpretMarksContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postInterpretMarksInner$,
    ),
  },
];
