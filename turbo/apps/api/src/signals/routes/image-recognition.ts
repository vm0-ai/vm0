import { imageRecognitionContract } from "@okouai/api-contracts/contracts/image-recognition";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { imageRecognition$ } from "../services/image-recognition.service";

const recognitionBody$ = bodyResultOf(imageRecognitionContract.recognize);

const recognizeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Image recognition route requires run authentication");
  }
  const bodyResult = await get(recognitionBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(imageRecognition$, { auth, body: bodyResult.data }, signal);
});

export const imageRecognitionRoutes: readonly RouteEntry[] = [
  {
    route: imageRecognitionContract.recognize,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "image-recognition:write",
      },
      recognizeInner$,
    ),
  },
];
