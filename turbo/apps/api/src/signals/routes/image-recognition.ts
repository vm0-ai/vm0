import { imageRecognitionContract } from "@okouai/api-contracts/contracts/image-recognition";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { imageRecognition$ } from "../services/image-recognition.service";

const imageRecognitionBody$ = bodyResultOf(
  imageRecognitionContract.imageRecognition,
);

const imageRecognitionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      throw new Error("Image recognition route requires run authentication");
    }
    const bodyResult = await get(imageRecognitionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      imageRecognition$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const imageRecognitionHandler$ = authRoute(
  {
    accept: ["agent"],
    requireOrganization: true,
    missingOrganizationStatus: 401,
    requiredCapability: "image-recognition:write",
  },
  imageRecognitionInner$,
);

export const imageRecognitionRoutes: readonly RouteEntry[] = [
  {
    route: imageRecognitionContract.imageRecognition,
    handler: imageRecognitionHandler$,
  },
  // Compatibility for immutable commit-addressed CLI artifacts that still call
  // `/api/recognize`. Keep until the canonical CLI and first-party guidance
  // have shipped, every pre-switch execution context has drained through queue,
  // execution, and finalization, and supported external callers no longer use
  // the old path. Remove in the evidence-backed cleanup phase tracked by #26929.
  {
    route: imageRecognitionContract.recognize,
    handler: imageRecognitionHandler$,
  },
];
