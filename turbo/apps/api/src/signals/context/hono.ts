import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  CLIENT_PRODUCT_HEADER,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  DESKTOP_PRODUCT_OKOU,
  desktopProductFromClientHeader,
} from "@okouai/api-contracts/contracts/client-headers";
import { command, computed, state } from "ccstate";
import type { Context } from "hono";
import { RedirectStatusCode } from "hono/utils/http-status";

import {
  allowedCorsOrigin,
  isOkouAppWorkerPreviewHostname,
} from "../../lib/cors";
import {
  previewAutomationBypassSecret,
  requestHasPreviewAutomationBypassHeaderOrCookie,
} from "../../lib/preview-automation-bypass";

const VM0_PRODUCTION_DOMAIN = "vm0.ai";
const OKOU_PRODUCTION_DOMAIN = "okou.ai";
const OKOU_ORIGIN_ROOT_DOMAINS = [
  OKOU_PRODUCTION_DOMAIN,
  "omby.ai",
  "okou-app.pages.dev",
] as const;

const innerHonoContext$ = state<Context>({} as Context);
const innerRoute$ = state<AppRoute | null>(null);
const innerApiStartTime$ = state<number | null>(null);

function belongsToDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function publicBrandFromApiHostname(hostname: string): PublicBrand | undefined {
  const normalizedHostname = hostname.toLowerCase();
  if (belongsToDomain(normalizedHostname, OKOU_PRODUCTION_DOMAIN)) {
    return "okou";
  }
  if (belongsToDomain(normalizedHostname, VM0_PRODUCTION_DOMAIN)) {
    return "vm0";
  }
  return undefined;
}

function publicBrandFromTrustedOrigin(
  origin: string | null,
): PublicBrand | undefined {
  const allowedOrigin = allowedCorsOrigin(origin ?? undefined);
  if (!allowedOrigin) {
    return undefined;
  }

  const hostname = new URL(allowedOrigin).hostname.toLowerCase();
  return OKOU_ORIGIN_ROOT_DOMAINS.some((domain) => {
    return belongsToDomain(hostname, domain);
  }) || isOkouAppWorkerPreviewHostname(hostname)
    ? "okou"
    : "vm0";
}

function publicBrandFromDesktopHeaders(
  headers: Headers,
): PublicBrand | undefined {
  if (headers.get(CLIENT_TYPE_HEADER) !== CLIENT_TYPE_DESKTOP) {
    return undefined;
  }
  return desktopProductFromClientHeader(headers.get(CLIENT_PRODUCT_HEADER)) ===
    DESKTOP_PRODUCT_OKOU
    ? "okou"
    : "vm0";
}

export const initHono$ = command(
  ({ set }, context: Context, route: AppRoute, apiStartTime: number): void => {
    set(innerHonoContext$, context);
    set(innerRoute$, route);
    set(innerApiStartTime$, apiStartTime);
  },
);

function header(name: string) {
  return computed((get) => {
    const context = get(innerHonoContext$);
    return context.req.header(name);
  });
}

export const userAgent$ = header("User-Agent");
export const authorization$ = header("authorization");
export const clientProduct$ = header(CLIENT_PRODUCT_HEADER);
export const cookie$ = header("cookie");
export const previewAutomationBypass$ = computed((get) => {
  const context = get(innerHonoContext$);
  const secret = previewAutomationBypassSecret();
  return secret &&
    requestHasPreviewAutomationBypassHeaderOrCookie(context.req.raw, secret)
    ? secret
    : undefined;
});

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

export const publicBrand$ = computed((get): PublicBrand => {
  const request = get(request$).raw;
  // A branded production hostname is authoritative. Neutral preview and local
  // API hosts fall through to the browser Origin or first-party Desktop header.
  return (
    publicBrandFromApiHostname(new URL(request.url).hostname) ??
    publicBrandFromTrustedOrigin(request.headers.get("origin")) ??
    publicBrandFromDesktopHeaders(request.headers) ??
    "vm0"
  );
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

export const apiStartTime$ = computed((get): number => {
  const apiStartTime = get(innerApiStartTime$);
  if (apiStartTime === null) {
    throw new Error("api start time accessed outside a request scope");
  }
  return apiStartTime;
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
