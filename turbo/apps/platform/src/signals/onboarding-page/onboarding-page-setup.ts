import { command } from "ccstate";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { createElement } from "react";
import { OnboardingPage } from "../../views/onboarding-page/onboarding-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import {
  markConnectorsFromUrl$,
  markUseCaseMode$,
  resetOnboardingStep$,
  toggleZeroConnector$,
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
  zeroSelectedConnectors$,
} from "../zero-page/zero-onboarding.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
export const setupOnboardingPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(OnboardingPage));
    set(updateDocumentTitle$, "Onboarding");
    await set(hideAppSkeleton$, signal);

    set(resetOnboardingStep$);
    signal.throwIfAborted();

    // Detect use-case deep link early — `?prompt=...&connector=...` lets even
    // already-onboarded users land here intentionally (to try a suggested
    // task), so we must NOT auto-redirect them home in that case.
    const earlyParams = get(searchParams$);
    const hasUseCaseLink =
      (earlyParams.get("prompt")?.length ?? 0) > 0 &&
      earlyParams.get("connector") !== null;

    // If onboarding is not needed and there's no use-case deep link, send the
    // user home — the page has nothing to show.
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();
    const needsMemberOnboarding = await get(zeroNeedsMemberOnboarding$);
    signal.throwIfAborted();

    if (!needsOnboarding && !needsMemberOnboarding && !hasUseCaseLink) {
      set(detachedNavigateTo$, "/", { replace: true });
      return;
    }

    // Fire Google Ads conversion event: user arrived at onboarding after signup
    type GtagFn = (...args: unknown[]) => void;
    (window as Window & { gtag?: GtagFn }).gtag?.("event", "conversion", {
      send_to: "AW-18144854014/OlLBCNXGgqwcEP7_kcxD",
    });

    // Consume ?connector= (comma-separated) to pre-select connectors. The
    // param is left on the URL so a refresh during onboarding still pre-fills
    // the same selection; it gets dropped naturally when step 4 navigates
    // away to /agents/.../chat or /works.
    const params = get(searchParams$);
    const connectorParam = params.get("connector");
    if (connectorParam !== null) {
      const isConnectorType = (id: string): id is ConnectorType => {
        return id in CONNECTOR_TYPES;
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
      // Mark the deep-link source so the picker step (step 2) is skipped —
      // the user already chose connectors via the URL.
      if (unique.length > 0) {
        set(markConnectorsFromUrl$);
      }
    }

    // "Use case" deep link: ?prompt=... + ?connector=... together signal that
    // the user came in from a specific suggested task. We seed an editable
    // prompt draft and switch onboarding into condensed mode where step 4
    // ("Where would you like to work?") is skipped and step 3 grows a
    // composer + "Try It" CTA that goes straight to the web chat.
    const promptParam = params.get("prompt");
    if (
      promptParam !== null &&
      promptParam.length > 0 &&
      connectorParam !== null
    ) {
      set(markUseCaseMode$, promptParam);
    }
  },
);
