import {
  DESKTOP_UPDATE_LINE_LEGACY_OKOU,
  DESKTOP_UPDATE_LINE_OKOU,
  DESKTOP_UPDATE_LINE_ZERO,
  desktopUpdatesContract,
  type DesktopZeroMigrationPolicy,
  type DesktopUpdateLine,
} from "@okouai/api-contracts/contracts/desktop-updates";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { setResHeader$ } from "../context/hono";
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

/**
 * The Zero Desktop migration policy this service serves.
 *
 * The policy used to be fetched from a GitHub release asset on every poll so
 * that it could be flipped without a deploy. `hard` was activated and verified
 * on 2026-08-31 and the owner confirmed it will not be rolled back, so the
 * mechanism is gone and the policy now changes only by editing this constant
 * and deploying.
 *
 * The endpoint itself has to stay: both this route and the desktop client fail
 * open to `soft`, so removing it would silently un-block every installed Zero
 * build that still polls.
 */
const DESKTOP_ZERO_MIGRATION_POLICY = {
  schemaVersion: 1,
  mode: "hard",
} as const satisfies DesktopZeroMigrationPolicy;

const getDesktopMigrationPolicy$ = command(({ set }) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return {
    status: 200 as const,
    body: DESKTOP_ZERO_MIGRATION_POLICY,
  };
});

/**
 * The update line the unqualified release-page and DMG routes serve.
 *
 * #28465 moved the contract from `/api/okou/desktop/updates/**` to the neutral
 * path, which makes the neutral path the successor of the `okou` form rather
 * than a new one: the platform download button and the Zero migration bridge
 * both point at it and both expect an Okou artifact.
 *
 * These two routes used to read the line off the request namespace, so the
 * `/api/zero/**` compatibility alias kept resolving to the Zero line its
 * callers reached before the move. #31088 removed the
 * `MIGRATED_BRANDED_PATHS` rows that registered that alias and nothing else
 * registers a branded path, so no request can arrive on one and the Zero
 * branch had no reachable input left. The Zero line is still reachable through
 * `productFeed`, `productReleasePage` and `productDmgDownload`, which name it
 * in the path.
 */
const UNQUALIFIED_DESKTOP_UPDATE_LINE: DesktopUpdateLine =
  DESKTOP_UPDATE_LINE_OKOU;

const getDesktopReleasePage$ = command(async ({ get }, signal: AbortSignal) => {
  const url = await loadDesktopReleasePageUrl(
    {
      line: UNQUALIFIED_DESKTOP_UPDATE_LINE,
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
      line: UNQUALIFIED_DESKTOP_UPDATE_LINE,
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
    route: desktopUpdatesContract.migrationPolicy,
    handler: getDesktopMigrationPolicy$,
  },
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
