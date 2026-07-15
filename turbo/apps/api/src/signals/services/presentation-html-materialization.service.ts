import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import type {
  MaterializedPresentationHtmlResponse,
  MaterializePresentationHtmlRequest,
} from "@vm0/api-contracts/contracts/zero-host";
import { hostedDeployments, hostedSites } from "@vm0/db/schema/hosted-site";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { settle } from "../utils";
import {
  HostedBrowserRenderingError,
  renderHostedBrowserContent,
} from "./hosted-browser-renderer.service";
import { sanitizeMaterializedPresentationHtml } from "./presentation-html-sanitizer.service";

const MAX_MATERIALIZED_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PRESENTATION_SLIDES = 500;
const PRESENTATION_SLIDE_SELECTOR = [
  "[data-vm0-slide]",
  "[data-slide]",
  "[data-slide-index]",
  "[data-page]",
  ".ppt-slide",
  ".presentation-slide",
  ".deck-slide",
  ".slide-page",
  ".slide",
  "section",
].join(",");

interface MaterializePresentationHtmlArgs {
  readonly body: MaterializePresentationHtmlRequest;
  readonly orgId: string;
}

type MaterializePresentationHtmlResult =
  | {
      readonly status: "ok";
      readonly body: MaterializedPresentationHtmlResponse;
    }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "not_configured"; readonly message: string }
  | { readonly status: "payload_too_large"; readonly message: string }
  | { readonly status: "presentation_not_found"; readonly message: string }
  | { readonly status: "provider_unavailable"; readonly message: string };

function publicSlugFromHostedSiteUrl(value: string): string | null {
  const url = new URL(value);
  const hostDomain = env("ZERO_HOST_DOMAIN");
  if (url.hostname === hostDomain || !url.hostname.endsWith(`.${hostDomain}`)) {
    return null;
  }
  const publicSlug = url.hostname.slice(0, -(hostDomain.length + 1));
  return publicSlug || null;
}

async function materializeDeploymentHtml(
  deployment: { readonly id: string; readonly url: string },
  signal: AbortSignal,
): Promise<MaterializePresentationHtmlResult> {
  const token = env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
  const wafSecret = env("ARTIFACT_PREVIEW_WAF_SECRET");
  if (!token || !wafSecret) {
    return {
      status: "not_configured",
      message: "Presentation HTML rendering is not configured",
    };
  }

  const contentResult = await settle(
    renderHostedBrowserContent(
      {
        token,
        wafSecret,
        url: deployment.url,
        actionTimeout: 15_000,
        waitForSelector: {
          selector: PRESENTATION_SLIDE_SELECTOR,
          timeout: 10_000,
        },
        rejectResourceTypes: [
          "xhr",
          "fetch",
          "eventsource",
          "websocket",
          "ping",
        ],
      },
      signal,
    ),
    signal,
  );
  if (!contentResult.ok) {
    if (!(contentResult.error instanceof HostedBrowserRenderingError)) {
      throw contentResult.error;
    }
    return {
      status: "provider_unavailable",
      message: contentResult.error.message,
    };
  }

  const sanitized = sanitizeMaterializedPresentationHtml(
    contentResult.value,
    deployment.url,
  );
  if (Buffer.byteLength(sanitized.html, "utf8") > MAX_MATERIALIZED_HTML_BYTES) {
    return {
      status: "payload_too_large",
      message: "Materialized presentation HTML exceeds 5 MB",
    };
  }
  if (sanitized.slideCount === 0) {
    return {
      status: "presentation_not_found",
      message: "No presentation slides were found after rendering",
    };
  }
  if (sanitized.slideCount > MAX_PRESENTATION_SLIDES) {
    return {
      status: "payload_too_large",
      message: "Materialized presentation exceeds 500 slides",
    };
  }

  return {
    status: "ok",
    body: {
      version: 1,
      html: sanitized.html,
      sourceUrl: deployment.url,
      sourceDeploymentId: deployment.id,
      slideCount: sanitized.slideCount,
    },
  };
}

export const materializePresentationHtml$ = command(
  async (
    { get },
    args: MaterializePresentationHtmlArgs,
    signal: AbortSignal,
  ): Promise<MaterializePresentationHtmlResult> => {
    const publicSlug = publicSlugFromHostedSiteUrl(args.body.url);
    if (!publicSlug) {
      return {
        status: "bad_request",
        message: "URL is not a hosted site URL",
      };
    }

    const db = get(db$);
    const [site] = await db
      .select({ activeDeploymentId: hostedSites.activeDeploymentId })
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.publicSlug, publicSlug),
          eq(hostedSites.orgId, args.orgId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!site) {
      return { status: "not_found", message: "Hosted site not found" };
    }
    if (!site.activeDeploymentId) {
      return {
        status: "conflict",
        message: "Hosted site has no active deployment",
      };
    }

    const [deployment] = await db
      .select({
        id: hostedDeployments.id,
        manifest: hostedDeployments.manifest,
        status: hostedDeployments.status,
        url: hostedDeployments.url,
      })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, site.activeDeploymentId),
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!deployment) {
      return {
        status: "not_found",
        message: "Active hosted deployment not found",
      };
    }
    if (deployment.status !== "ready") {
      return {
        status: "conflict",
        message: "Active hosted deployment is not ready",
      };
    }
    if (deployment.manifest.artifactKind !== "presentation-html") {
      return {
        status: "bad_request",
        message: "Hosted site is not a presentation HTML artifact",
      };
    }

    return materializeDeploymentHtml(deployment, signal);
  },
);
