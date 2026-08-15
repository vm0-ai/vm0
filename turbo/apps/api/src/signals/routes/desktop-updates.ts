import { brandedApiNamespace } from "@okouai/api-contracts/contracts/api-namespaces";
import {
  DESKTOP_UPDATE_LINE_LEGACY_OKOU,
  DESKTOP_UPDATE_LINE_OKOU,
  DESKTOP_UPDATE_LINE_ZERO,
  desktopUpdatesContract,
  desktopZeroMigrationPolicySchema,
  type DesktopZeroMigrationPolicy,
  type DesktopUpdateLine,
} from "@okouai/api-contracts/contracts/desktop-updates";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { request$, setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
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
const DESKTOP_ZERO_MIGRATION_POLICY_URL =
  "https://github.com/vm0-ai/vm0/releases/download/desktop-migration-policy/desktop-migration-policy.json";
const SAFE_DESKTOP_ZERO_MIGRATION_POLICY = {
  schemaVersion: 1,
  mode: "soft",
} as const satisfies DesktopZeroMigrationPolicy;
const DESKTOP_ZERO_MIGRATION_POLICY_MAX_BYTES = 1024;

async function fetchDesktopZeroMigrationPolicy(
  signal: AbortSignal,
): Promise<DesktopZeroMigrationPolicy> {
  const fetched = await settle(
    fetch(DESKTOP_ZERO_MIGRATION_POLICY_URL, {
      headers: { Accept: "application/json" },
      signal,
    }),
    signal,
  );
  if (!fetched.ok || !fetched.value.ok) {
    return SAFE_DESKTOP_ZERO_MIGRATION_POLICY;
  }
  const body = await settle(
    readBoundedResponseText(
      fetched.value,
      DESKTOP_ZERO_MIGRATION_POLICY_MAX_BYTES,
    ),
    signal,
  );
  if (!body.ok || body.value.kind !== "text") {
    return SAFE_DESKTOP_ZERO_MIGRATION_POLICY;
  }
  const parsed = desktopZeroMigrationPolicySchema.safeParse(
    safeJsonParse(body.value.text),
  );
  return parsed.success ? parsed.data : SAFE_DESKTOP_ZERO_MIGRATION_POLICY;
}

const getDesktopMigrationPolicy$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    return {
      status: 200 as const,
      body: await fetchDesktopZeroMigrationPolicy(signal),
    };
  },
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
