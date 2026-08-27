import {
  setupOnboardingImageRunPage$,
  setupOnboardingImageTemplatePage$,
  setupOnboardingMakePage$,
  setupOnboardingPresentationRunPage$,
  setupOnboardingPresentationTemplatePage$,
  setupOnboardingVideoRunPage$,
  setupOnboardingVideoTemplatePage$,
  setupOnboardingWorkflowPickerPage$,
  setupOnboardingWorkflowRunPage$,
} from "../onboarding/onboarding-page-setup.ts";

export function getOnboardingRouteSetups() {
  return {
    setupOnboardingImageRunPage$,
    setupOnboardingImageTemplatePage$,
    setupOnboardingMakePage$,
    setupOnboardingPresentationRunPage$,
    setupOnboardingPresentationTemplatePage$,
    setupOnboardingVideoRunPage$,
    setupOnboardingVideoTemplatePage$,
    setupOnboardingWorkflowPickerPage$,
    setupOnboardingWorkflowRunPage$,
  };
}
