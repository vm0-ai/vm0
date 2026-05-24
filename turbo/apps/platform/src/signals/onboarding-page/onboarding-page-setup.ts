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
  markUseCaseMode$,
  resetOnboardingStep$,
  toggleZeroConnector$,
  zeroNeedsOnboarding$,
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

    // Detect use-case deep link early — `?prompt=...` (optionally with
    // `&connector=...`) lets even already-onboarded users (including
    // non-admins) land here intentionally to try a suggested task, so we
    // must NOT auto-redirect them home then.
    const earlyParams = get(searchParams$);
    const hasUseCaseLink = (earlyParams.get("prompt")?.length ?? 0) > 0;

    // Onboarding is purely admin workspace setup. If onboarding is not needed
    // (non-admins, or admins whose workspace is already set up) and there's no
    // use-case deep link, send the user home — the page has nothing to show.
    const needsOnboarding = await get(zeroNeedsOnboarding$);
    signal.throwIfAborted();

    if (!needsOnboarding && !hasUseCaseLink) {
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
    // the same selection; it gets dropped naturally when finishing onboarding
    // navigates away to /agents/.../chat.
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
    }

    // "Use case" deep link: ?prompt=... (optionally with ?connector=...)
    // signals that the user came in from a specific suggested task. We seed
    // an editable prompt draft and switch onboarding into condensed mode
    // where the flow collapses to step 3, which grows a composer + "Try It"
    // CTA that goes straight to the web chat.
    const promptParam = params.get("prompt");
    if (promptParam !== null && promptParam.length > 0) {
      set(markUseCaseMode$, promptParam);
    }
  },
);
