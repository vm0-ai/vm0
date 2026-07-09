import { command } from "ccstate";
import { zeroImageIoInterpretMarksContract } from "@vm0/api-contracts/contracts/zero-image-io-interpret-marks";

import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { interpretRegionMarks } from "../services/zero-image-interpret-marks.service";

const interpretMarksBody$ = bodyResultOf(
  zeroImageIoInterpretMarksContract.post,
);

const postInterpretMarksInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const bodyResult = await get(interpretMarksBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const regions = await interpretRegionMarks({
      imageUrl: bodyResult.data.imageUrl,
      regions: bodyResult.data.regions,
    });
    signal.throwIfAborted();

    return { status: 200 as const, body: { regions } };
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
