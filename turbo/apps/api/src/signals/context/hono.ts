import { command, computed, state } from "ccstate";
import type { Context } from "hono";
import { RedirectStatusCode } from "hono/utils/http-status";

const innerHonoContext$ = state<Context>({} as Context);

export const initHono$ = command(({ set }, context: Context) => {
  set(innerHonoContext$, context);
});

// Request Headers
function header(name: string) {
  return computed((get) => {
    const context = get(innerHonoContext$);
    return context.req.header(name);
  });
}

export const userAgent$ = header("User-Agent");

// Response Headers
export const resUserAgent$ = resHeader("User-Agent");
function resHeader(name: string) {
  return computed((get) => {
    const context = get(innerHonoContext$);
    return context.res.headers.get(name);
  });
}

// Request
export const request$ = computed((get) => {
  const context = get(innerHonoContext$);
  return context.req;
});

export const requestSignal$ = computed((get) => {
  const context = get(innerHonoContext$);
  return context.req.raw.signal;
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
