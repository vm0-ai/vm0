import { command } from "ccstate";
import { appSkeletonVisible$, hideAppSkeleton$ } from "./app-skeleton.ts";
import { createDeferredPromise, onRef } from "./utils.ts";

// Clerk uses this host marker and child check to decide when to remove fallback.
const CLERK_COMPONENT_SELECTOR = "[data-clerk-component]";

function hasMountedClerkComponent(element: HTMLElement): boolean {
  const clerkComponent = element.querySelector(CLERK_COMPONENT_SELECTOR);
  return clerkComponent !== null && clerkComponent.childElementCount > 0;
}

const hideAppSkeletonWhenAuthMounts$ = command(
  async (
    { get, set },
    element: HTMLDivElement,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!hasMountedClerkComponent(element)) {
      const mounted = createDeferredPromise<void>(signal);
      const observer = new MutationObserver(() => {
        if (hasMountedClerkComponent(element) && !mounted.settled()) {
          mounted.resolve();
        }
      });
      const disconnectObserver = () => {
        observer.disconnect();
      };

      signal.addEventListener("abort", disconnectObserver, { once: true });
      observer.observe(element, { childList: true, subtree: true });

      if (hasMountedClerkComponent(element) && !mounted.settled()) {
        mounted.resolve();
      }

      await mounted.promise;
      signal.throwIfAborted();
      observer.disconnect();
      signal.removeEventListener("abort", disconnectObserver);
    }

    signal.throwIfAborted();
    if (get(appSkeletonVisible$)) {
      await set(hideAppSkeleton$, signal);
    }
  },
);

export const authPageMountRef$ = onRef(hideAppSkeletonWhenAuthMounts$);
