import { desktopUpdatesContract } from "@vm0/api-contracts/contracts/desktop-updates";
import { brandedApiNamespace } from "@vm0/api-contracts/contracts/api-namespaces";
import {
  DESKTOP_PRODUCT_OKOU,
  DESKTOP_PRODUCT_ZERO,
  type DesktopProduct,
} from "@vm0/api-contracts/contracts/client-headers";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  loadDesktopDmgDownloadUrl,
  loadDesktopReleasePageUrl,
  loadDesktopUpdateFeed,
} from "../services/desktop-updates.service";

const feedParams$ = pathParamsOf(desktopUpdatesContract.feed);
const releasePageParams$ = pathParamsOf(desktopUpdatesContract.releasePage);
const dmgDownloadParams$ = pathParamsOf(desktopUpdatesContract.dmgDownload);
const productFeedParams$ = pathParamsOf(desktopUpdatesContract.productFeed);
const productReleasePageParams$ = pathParamsOf(
  desktopUpdatesContract.productReleasePage,
);
const productDmgDownloadParams$ = pathParamsOf(
  desktopUpdatesContract.productDmgDownload,
);

function desktopProductFromRequestUrl(requestUrl: string): DesktopProduct {
  return brandedApiNamespace(new URL(requestUrl).pathname) === "okou"
    ? DESKTOP_PRODUCT_OKOU
    : DESKTOP_PRODUCT_ZERO;
}

const getDesktopReleasePage$ = command(async ({ get }, signal: AbortSignal) => {
  const url = await loadDesktopReleasePageUrl(
    {
      product: desktopProductFromRequestUrl(get(request$).url),
      ...get(releasePageParams$),
    },
    signal,
  );
  signal.throwIfAborted();

  if (!url) {
    return notFound("No desktop release is available for this feed.");
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
    },
  });
});

const getDesktopUpdateFeed$ = command(async ({ get }, signal: AbortSignal) => {
  const feed = await loadDesktopUpdateFeed(
    { product: DESKTOP_PRODUCT_ZERO, ...get(feedParams$) },
    signal,
  );
  signal.throwIfAborted();

  if (!feed) {
    return notFound("No desktop update is available for this feed.");
  }

  return {
    status: 200 as const,
    body: feed,
  };
});

const getDesktopDmgDownload$ = command(async ({ get }, signal: AbortSignal) => {
  const url = await loadDesktopDmgDownloadUrl(
    {
      product: desktopProductFromRequestUrl(get(request$).url),
      ...get(dmgDownloadParams$),
    },
    signal,
  );
  signal.throwIfAborted();

  if (!url) {
    return notFound("No desktop DMG is available for this feed.");
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store",
    },
  });
});

const getProductDesktopReleasePage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const url = await loadDesktopReleasePageUrl(
      get(productReleasePageParams$),
      signal,
    );
    signal.throwIfAborted();

    if (!url) {
      return notFound("No desktop release is available for this feed.");
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "no-store",
      },
    });
  },
);

const getProductDesktopUpdateFeed$ = command(
  async ({ get }, signal: AbortSignal) => {
    const feed = await loadDesktopUpdateFeed(get(productFeedParams$), signal);
    signal.throwIfAborted();

    if (!feed) {
      return notFound("No desktop update is available for this feed.");
    }

    return {
      status: 200 as const,
      body: feed,
    };
  },
);

const getProductDesktopDmgDownload$ = command(
  async ({ get }, signal: AbortSignal) => {
    const url = await loadDesktopDmgDownloadUrl(
      get(productDmgDownloadParams$),
      signal,
    );
    signal.throwIfAborted();

    if (!url) {
      return notFound("No desktop DMG is available for this feed.");
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        "Cache-Control": "no-store",
      },
    });
  },
);

export const desktopUpdateRoutes: readonly RouteEntry[] = [
  {
    route: desktopUpdatesContract.releasePage,
    handler: getDesktopReleasePage$,
  },
  {
    route: desktopUpdatesContract.dmgDownload,
    handler: getDesktopDmgDownload$,
  },
  {
    route: desktopUpdatesContract.feed,
    handler: getDesktopUpdateFeed$,
  },
  {
    route: desktopUpdatesContract.productReleasePage,
    handler: getProductDesktopReleasePage$,
  },
  {
    route: desktopUpdatesContract.productDmgDownload,
    handler: getProductDesktopDmgDownload$,
  },
  {
    route: desktopUpdatesContract.productFeed,
    handler: getProductDesktopUpdateFeed$,
  },
];
