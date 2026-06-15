import { desktopUpdatesContract } from "@vm0/api-contracts/contracts/desktop-updates";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  loadDesktopReleasePageUrl,
  loadDesktopUpdateFeed,
} from "../services/desktop-updates.service";

const feedParams$ = pathParamsOf(desktopUpdatesContract.feed);
const releasePageParams$ = pathParamsOf(desktopUpdatesContract.releasePage);

const getDesktopReleasePage$ = command(async ({ get }, signal: AbortSignal) => {
  const url = await loadDesktopReleasePageUrl(get(releasePageParams$), signal);
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
  const feed = await loadDesktopUpdateFeed(get(feedParams$), signal);
  signal.throwIfAborted();

  if (!feed) {
    return notFound("No desktop update is available for this feed.");
  }

  return {
    status: 200 as const,
    body: feed,
  };
});

export const desktopUpdateRoutes: readonly RouteEntry[] = [
  {
    route: desktopUpdatesContract.releasePage,
    handler: getDesktopReleasePage$,
  },
  {
    route: desktopUpdatesContract.feed,
    handler: getDesktopUpdateFeed$,
  },
];
