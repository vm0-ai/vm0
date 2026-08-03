import { zeroRecognitionContract } from "@vm0/api-contracts/contracts/zero-recognition";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroRecognition$ } from "../services/zero-recognition.service";

const recognitionBody$ = bodyResultOf(zeroRecognitionContract.recognize);

const recognizeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "zero") {
    throw new Error("Zero recognition route requires Zero authentication");
  }
  const bodyResult = await get(recognitionBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(zeroRecognition$, { auth, body: bodyResult.data }, signal);
});

export const zeroRecognitionRoutes: readonly RouteEntry[] = [
  {
    route: zeroRecognitionContract.recognize,
    handler: authRoute(
      {
        accept: ["zero"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "image-recognition:write",
      },
      recognizeInner$,
    ),
  },
];
