import { command, computed, state } from "ccstate";

// Matches Tailwind's md breakpoint (768px). Below this width we render the
// mobile-native chrome / behaviors. Above it the desktop layout takes over,
// even when the MobileNativeV1 feature switch is on — the redesign is a
// mobile experience, not a global skin.
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

function readMatch(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(MOBILE_MEDIA_QUERY).matches
  );
}

const internalIsMobileViewport$ = state(readMatch());

export const isMobileViewport$ = computed((get) => {
  return get(internalIsMobileViewport$);
});

export const watchMobileViewport$ = command(({ set }, signal: AbortSignal) => {
  if (typeof window === "undefined") {
    return;
  }
  const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  const onChange = () => {
    set(internalIsMobileViewport$, mql.matches);
  };
  onChange();
  mql.addEventListener("change", onChange);
  signal.addEventListener("abort", () => {
    mql.removeEventListener("change", onChange);
  });
});
