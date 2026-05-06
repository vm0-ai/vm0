type PlausibleEventProps = Record<string, string | number | boolean>;

interface PlausibleEventOptions {
  props?: PlausibleEventProps;
  callback?: () => void;
}

type PlausibleFn = {
  (eventName: string, options?: PlausibleEventOptions): void;
  q?: [string, PlausibleEventOptions?][];
  init?: (options?: unknown) => void;
  o?: unknown;
};

const PLAUSIBLE_SCRIPT_URL = import.meta.env.VITE_PLAUSIBLE_SCRIPT_URL as
  | string
  | undefined;

declare global {
  interface Window {
    plausible?: PlausibleFn;
  }
}

export function capturePlausibleEvent(
  eventName: string,
  options?: PlausibleEventOptions,
): void {
  const plausible = getPlausible();
  plausible?.(eventName, options);
}

function getPlausible(): PlausibleFn | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (window.plausible) {
    return window.plausible;
  }

  if (!PLAUSIBLE_SCRIPT_URL?.includes("plausible")) {
    return null;
  }

  const plausible = ((...args: [string, PlausibleEventOptions?]) => {
    plausible.q = plausible.q ?? [];
    plausible.q.push(args);
  }) as PlausibleFn;

  window.plausible = plausible;
  return plausible;
}
