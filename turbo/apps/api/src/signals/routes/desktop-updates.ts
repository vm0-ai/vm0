import {
  DESKTOP_UPDATE_LINE_LEGACY_OKOU,
  DESKTOP_UPDATE_LINE_OKOU,
  DESKTOP_UPDATE_LINE_ZERO,
  desktopUpdatesContract,
  type DesktopZeroMigrationPolicy,
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
 * `/api/desktop/updates/stable/darwin/arm64/dmg` is what the migration wall's
 * `Download Okou` button opens and what the bridge compiled into installed Zero
 * builds hard-codes, so this constant must keep resolving to the current Okou
 * DMG. The unqualified RELEASES.json feed used to resolve to Zero instead;
 * #31475 removed that route rather than aligning it, because a Zero client
 * cannot cross to the Okou bundle through Squirrel and no other caller reached
 * it.
 */
const UNQUALIFIED_DESKTOP_UPDATE_LINE = DESKTOP_UPDATE_LINE_OKOU;

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

// All three `:product` handlers below reject the same retired lines. `okou` is
// the pre-adoption Okou line. `zero` joined it in #31475: its manifest had been
// frozen since the `hard` migration policy went live, and the only clients left
// polling it were Squirrel auto-updaters that cannot cross from the Zero bundle
// to the Okou one, so the feed could not upgrade anyone. Neither line is
// removed from the contract union — see the note there.

const getProductDesktopReleasePage$ = command(
  async ({ get }, signal: AbortSignal) => {
    const { product, ...params } = get(productReleasePageParams$);
    if (
      product === DESKTOP_UPDATE_LINE_LEGACY_OKOU ||
      product === DESKTOP_UPDATE_LINE_ZERO
    ) {
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
    if (
      product === DESKTOP_UPDATE_LINE_LEGACY_OKOU ||
      product === DESKTOP_UPDATE_LINE_ZERO
    ) {
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
    if (
      product === DESKTOP_UPDATE_LINE_LEGACY_OKOU ||
      product === DESKTOP_UPDATE_LINE_ZERO
    ) {
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
