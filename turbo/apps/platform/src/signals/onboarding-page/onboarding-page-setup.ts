import { command } from "ccstate";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createElement } from "react";
import { OnboardingPage } from "../../views/onboarding-page/onboarding-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import {
  markUseCaseMode$,
  resetOnboardingStep$,
  toggleZeroConnector$,
  zeroNeedsOnboarding$,
  zeroSelectedConnectors$,
} from "../zero-page/zero-onboarding.ts";
import { redirectToConfiguredOnboarding$ } from "../zero-page/onboard-guard.ts";
import {
  onboardingEffectiveStep$,
  continueOnboardingAfterCheckout$,
  redeemOnboardingSearchParamCode$,
} from "../zero-page/zero-onboarding-actions.ts";
import {
  clearCompletedBillingCheckout$,
  completedBillingCheckout$,
} from "../zero-page/billing.ts";
import { allConnectorTypes$ } from "../zero-page/settings/connectors.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  startOnboardingSessionRecording,
  stopOnboardingSessionRecording,
} from "../../lib/posthog.ts";
export const setupOnboardingPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(OnboardingPage));
    set(updateDocumentTitle$, "Onboarding");
    await set(hideAppSkeleton$, signal);

    set(resetOnboardingStep$);
    signal.throwIfAborted();

    const params = get(searchParams$);
    const promptParam = params.get("prompt");
    const hasUseCaseLink = (promptParam?.length ?? 0) > 0;

    // Seed use-case mode before async status checks so the visible onboarding
    // step cannot race ahead as the regular connector flow.
    if (promptParam !== null && promptParam.length > 0) {
      set(markUseCaseMode$, promptParam);
    }

    const completedBillingCheckoutState = get(completedBillingCheckout$);
    if (completedBillingCheckoutState) {
      const continued = await set(
        continueOnboardingAfterCheckout$,
        completedBillingCheckoutState.sessionId,
        signal,
      );
      signal.throwIfAborted();
      if (continued) {
        set(clearCompletedBillingCheckout$);
        return;
      }
    }

    // Use-case deep links intentionally land already-onboarded users here, so
    // compute that before deciding whether the page should send users home.
    // Onboarding is purely admin workspace setup. If onboarding is not needed
    // (non-admins, or admins whose workspace is already set up) and there's no
    // use-case deep link, send the user home — the page has nothing to show.
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();

    const features = get(featureSwitch$);
    if (needsOnboarding && features[FeatureSwitchKey.PaidOnboardingRedirect]) {
      set(redirectToConfiguredOnboarding$, params);
      return;
    }

    if (!needsOnboarding && !hasUseCaseLink) {
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    // Connector pre-selection runs only after the paid-redirect decision, so
    // direct paid links can forward raw query params without waiting on the
    // connector catalog.
    // Consume ?connector= (comma-separated) to pre-select connectors. The
    // param is left on the URL so a refresh during onboarding still pre-fills
    // the same selection; it gets dropped naturally when finishing onboarding
    // navigates away to /agents/.../chat.
    const connectorParam = params.get("connector");
    if (connectorParam !== null) {
      const availableConnectors = await get(allConnectorTypes$);
      signal.throwIfAborted();
      const availableTypes = new Set(
        availableConnectors.map((connector) => {
          return connector.type;
        }),
      );
      const isConnectorType = (id: string): id is ConnectorType => {
        return availableTypes.has(id as ConnectorType);
      };
      const alreadySelected = new Set<ConnectorType>(
        get(zeroSelectedConnectors$),
      );
      const connectorIds = connectorParam
        .split(",")
        .map((id) => {
          return id.trim();
        })
        .filter(isConnectorType);
      const unique = Array.from(new Set(connectorIds));
      for (const id of unique) {
        if (!alreadySelected.has(id)) {
          set(toggleZeroConnector$, id);
          alreadySelected.add(id);
        }
      }
    }

    // "Use case" deep link: ?prompt=... (optionally with ?connector=...)
    // signals that the user came in from a specific suggested task. We seed
    // an editable prompt draft and switch onboarding into condensed mode
    // where the flow collapses to step 3, which grows a composer + "Try It"
    // CTA that goes straight to the web chat.
    const effectiveStep = await get(onboardingEffectiveStep$);
    signal.throwIfAborted();
    if (effectiveStep === "4") {
      const redeemed = await set(redeemOnboardingSearchParamCode$, signal);
      signal.throwIfAborted();
      if (redeemed) {
        return;
      }
    }

    // Scope session replay to the onboarding flow so we can see where new users
    // drop off. Masked (all inputs + text); stops when the route unmounts.
    startOnboardingSessionRecording();
    signal.addEventListener("abort", () => {
      stopOnboardingSessionRecording();
    });

    // Fire Google Ads conversion event: user arrived at onboarding after signup
    type GtagFn = (...args: unknown[]) => void;
    (window as Window & { gtag?: GtagFn }).gtag?.("event", "conversion", {
      send_to: "AW-18144854014/OlLBCNXGgqwcEP7_kcxD",
    });
  },
);
