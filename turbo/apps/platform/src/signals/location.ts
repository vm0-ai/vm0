class LocationOverrides {
  ownerSignal: AbortSignal | undefined = undefined;
  pathname: string | undefined = undefined;
  search: string | undefined = undefined;
  hash: string | undefined = undefined;
  pushState: typeof window.history.pushState | undefined = undefined;
  replaceState: typeof window.history.replaceState | undefined = undefined;
}

const overrides = new LocationOverrides();

function clearOverrideValues(): void {
  overrides.pathname = undefined;
  overrides.search = undefined;
  overrides.hash = undefined;
  overrides.pushState = undefined;
  overrides.replaceState = undefined;
}

function ownOverrides(signal: AbortSignal): void {
  if (overrides.ownerSignal === signal) {
    return;
  }
  signal.throwIfAborted();
  clearOverrideValues();
  overrides.ownerSignal = signal;
  signal.addEventListener(
    "abort",
    () => {
      if (overrides.ownerSignal !== signal) {
        return;
      }
      overrides.ownerSignal = undefined;
      clearOverrideValues();
    },
    { once: true },
  );
}

export const setPathname = (pathname: string, signal: AbortSignal) => {
  ownOverrides(signal);
  overrides.pathname = pathname;
};

export const setSearch = (search: string, signal: AbortSignal) => {
  ownOverrides(signal);
  overrides.search = search;
};

export const setHash = (hash: string, signal: AbortSignal) => {
  ownOverrides(signal);
  overrides.hash = hash;
};

export const pathname = () => {
  return overrides.pathname ?? location.pathname;
};

export const search = () => {
  return overrides.search ?? location.search;
};

export const hash = () => {
  return overrides.hash ?? location.hash;
};

export const pushState = (
  data: Parameters<typeof window.history.pushState>[0],
  unused: Parameters<typeof window.history.pushState>[1],
  url: Parameters<typeof window.history.pushState>[2],
) => {
  if (overrides.pushState) {
    overrides.pushState.call(window.history, data, unused, url);
  } else {
    window.history.pushState(data, unused, url);
  }
};

export function mockPushState(
  fn: typeof window.history.pushState | undefined,
  signal: AbortSignal,
) {
  ownOverrides(signal);
  overrides.pushState = fn;
}

export const replaceState = (
  data: Parameters<typeof window.history.replaceState>[0],
  unused: Parameters<typeof window.history.replaceState>[1],
  url: Parameters<typeof window.history.replaceState>[2],
) => {
  if (overrides.replaceState) {
    overrides.replaceState.call(window.history, data, unused, url);
  } else {
    window.history.replaceState(data, unused, url);
  }
};

export function mockReplaceState(
  fn: typeof window.history.replaceState | undefined,
  signal: AbortSignal,
) {
  ownOverrides(signal);
  overrides.replaceState = fn;
}
