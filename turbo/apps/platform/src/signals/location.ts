// we use mutable package variables to mock location properties
// eslint-disable-next-line ccstate/no-package-variable
let _pathname: string | undefined = undefined;

// we use mutable package variables to mock location properties
// eslint-disable-next-line ccstate/no-package-variable
let _search: string | undefined = undefined;

// we use mutable package variables to mock location properties
// eslint-disable-next-line ccstate/no-package-variable
let _origin: string | undefined = undefined;

// we use mutable package variables to mock location properties
// eslint-disable-next-line ccstate/no-package-variable
let _pushState: typeof window.history.pushState | undefined = undefined;

export const setPathname = (pathname: string) => {
  _pathname = pathname;
};

export const setSearch = (search: string) => {
  _search = search;
};

export const setOrigin = (origin: string) => {
  _origin = origin;
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
  _pathname = pathname;
  _search = search;

  signal.addEventListener("abort", () => {
    _pathname = undefined;
    _search = undefined;
  });
}

export const pathname = () => {
  return _pathname ?? location.pathname;
};

export const search = () => {
  return _search ?? location.search;
};

export const origin = () => {
  return _origin ?? location.origin;
};

export const pushState = (
  data: Parameters<typeof window.history.pushState>[0],
  unused: Parameters<typeof window.history.pushState>[1],
  url: Parameters<typeof window.history.pushState>[2],
) => {
  if (_pushState) {
    _pushState.call(window.history, data, unused, url);
  } else {
    window.history.pushState(data, unused, url);
  }
};

export function mockPushState(
  fn: typeof window.history.pushState | undefined,
  signal: AbortSignal,
) {
  _pushState = fn;
  signal.addEventListener("abort", () => {
    _pushState = undefined;
  });
}
