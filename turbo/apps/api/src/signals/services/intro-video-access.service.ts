import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { EXPLAINER_VIDEO_TEMPLATE_ID } from "@okouai/core/explainer-video-template";
import { computed } from "ccstate";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

export const introVideoDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Intro Video is not enabled",
      code: "FORBIDDEN" as const,
    }),
  }),
});

export const introVideoEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const context = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.IntroVideo, context);
});

export function loadIntroVideoTemplateAccess(
  templates: readonly GenerationTemplateRequest[],
  context: FeatureSwitchContext,
): boolean {
  if (
    !templates.some((template) => {
      return (
        template.type === "video" &&
        template.selection.stylePresetId === EXPLAINER_VIDEO_TEMPLATE_ID
      );
    })
  ) {
    return false;
  }
  return isFeatureEnabled(FeatureSwitchKey.IntroVideo, context);
}
