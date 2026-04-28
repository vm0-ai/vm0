import type { AppRoute } from "@ts-rest/core";
import { command, computed, state } from "ccstate";
import type { Context } from "hono";
import { RedirectStatusCode } from "hono/utils/http-status";

const innerHonoContext$ = state<Context>({} as Context);
const innerRoute$ = state<AppRoute | null>(null);

export const initHono$ = command(
  ({ set }, context: Context, route: AppRoute): void => {
    set(innerHonoContext$, context);
    set(innerRoute$, route);
  },
);

// Request Headers
function header(name: string) {
  return computed((get) => {
    const context = get(innerHonoContext$);
    return context.req.header(name);
  });
}

export const userAgent$ = header("User-Agent");
export const authorization$ = header("authorization");
export const cookie$ = header("cookie");

// Response Headers
function resHeader(name: string) {
  return computed((get) => {
    const context = get(innerHonoContext$);
    return context.res.headers.get(name);
  });
}

export const resUserAgent$ = resHeader("User-Agent");

// Request
export const request$ = computed((get) => {
  const context = get(innerHonoContext$);
  return context.req;
});

export const requestSignal$ = computed((get) => {
  const context = get(innerHonoContext$);
  return context.req.raw.signal;
});

export const route$ = computed((get): AppRoute => {
  const route = get(innerRoute$);
  if (!route) {
    throw new Error("route accessed outside a request scope");
  }
  return route;
});

export const rawPathParams$ = computed((get) => {
  const context = get(innerHonoContext$);
  return context.req.param();
});

export const rawQuery$ = computed((get) => {
  const context = get(innerHonoContext$);
  return context.req.query();
});

// Response
export const setResHeader$ = command(
  ({ get }, name: string, value?: string, options?: { append?: boolean }) => {
    const context = get(innerHonoContext$);
    context.header(name, value, options);
  },
);

export const redirect$ = command(
  ({ get }, url: string | URL, status?: RedirectStatusCode) => {
    const context = get(innerHonoContext$);
    context.redirect(url, status);
  },
);
