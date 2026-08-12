import { brandedApiNamespace } from "@vm0/api-contracts/contracts/api-namespaces";
import {
  DESKTOP_UPDATE_LINE_LEGACY_OKOU,
  DESKTOP_UPDATE_LINE_OKOU,
  DESKTOP_UPDATE_LINE_ZERO,
  desktopUpdatesContract,
  type DesktopUpdateLine,
} from "@vm0/api-contracts/contracts/desktop-updates";
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

function desktopUpdateLineFromRequestUrl(
  requestUrl: string,
): DesktopUpdateLine {
  return brandedApiNamespace(new URL(requestUrl).pathname) === "okou"
    ? DESKTOP_UPDATE_LINE_OKOU
    : DESKTOP_UPDATE_LINE_ZERO;
}

const getDesktopReleasePage$ = command(async ({ get }, signal: AbortSignal) => {
  const url = await loadDesktopReleasePageUrl(
    {
      line: desktopUpdateLineFromRequestUrl(get(request$).url),
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
    { line: DESKTOP_UPDATE_LINE_ZERO, ...get(feedParams$) },
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
      line: desktopUpdateLineFromRequestUrl(get(request$).url),
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
    const { product, ...params } = get(productReleasePageParams$);
    if (product === DESKTOP_UPDATE_LINE_LEGACY_OKOU) {
      return notFound("This desktop update line is retired.");
    }
    const url = await loadDesktopReleasePageUrl(
      { line: product, ...params },
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
    const { product, ...params } = get(productFeedParams$);
    if (product === DESKTOP_UPDATE_LINE_LEGACY_OKOU) {
      return notFound("This desktop update line is retired.");
    }
    const feed = await loadDesktopUpdateFeed(
      { line: product, ...params },
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
  },
);

const getProductDesktopDmgDownload$ = command(
  async ({ get }, signal: AbortSignal) => {
    const { product, ...params } = get(productDmgDownloadParams$);
    if (product === DESKTOP_UPDATE_LINE_LEGACY_OKOU) {
      return notFound("This desktop update line is retired.");
    }
    const url = await loadDesktopDmgDownloadUrl(
      { line: product, ...params },
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
