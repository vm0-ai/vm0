class LocationOverrides {
  pathname: string | undefined = undefined;
  search: string | undefined = undefined;
  origin: string | undefined = undefined;
  pushState: typeof window.history.pushState | undefined = undefined;
  replaceState: typeof window.history.replaceState | undefined = undefined;
}

const overrides = new LocationOverrides();

export const setPathname = (pathname: string) => {
  overrides.pathname = pathname;
};

export const setSearch = (search: string) => {
  overrides.search = search;
};

export const setOrigin = (origin: string) => {
  overrides.origin = origin;
};

export function mockLocation(
  {
    pathname,
    search,
  }: {
    pathname: string;
    search: string;
  },
  signal: AbortSignal,
) {
  overrides.pathname = pathname;
  overrides.search = search;

  signal.addEventListener("abort", () => {
    overrides.pathname = undefined;
    overrides.search = undefined;
  });
}

export const pathname = () => {
  return overrides.pathname ?? location.pathname;
};

export const search = () => {
  return overrides.search ?? location.search;
};

export const origin = () => {
  return overrides.origin ?? location.origin;
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
  overrides.pushState = fn;
  signal.addEventListener("abort", () => {
    overrides.pushState = undefined;
  });
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
  overrides.replaceState = fn;
  signal.addEventListener("abort", () => {
    overrides.replaceState = undefined;
  });
}
