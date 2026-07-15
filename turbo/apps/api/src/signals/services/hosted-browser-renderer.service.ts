import { z } from "zod";

import { env } from "../../lib/env";

const HOSTED_BROWSER_VIEWPORT = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 0.5,
} as const;
const HOSTED_BROWSER_WAF_COOKIE_NAME = "vm0_artifact_preview";

const browserSnapshotSchema = z.object({
  meta: z.object({
    status: z.number().optional(),
    title: z.string().optional(),
  }),
  success: z.literal(true),
  result: z.object({
    content: z.string().min(1),
    screenshot: z.string().min(1).optional(),
  }),
});

const browserContentSchema = z.object({
  meta: z.object({
    status: z.number().optional(),
    title: z.string().optional(),
  }),
  success: z.literal(true),
  result: z.string().min(1),
});

type HostedBrowserSnapshotFormat = "content" | "screenshot";
type HostedBrowserRejectedResourceType =
  | "eventsource"
  | "fetch"
  | "ping"
  | "websocket"
  | "xhr";

interface HostedBrowserSnapshotRequest {
  readonly actionTimeout?: number;
  readonly bestAttempt?: true;
  readonly cookies: readonly {
    readonly httpOnly: true;
    readonly name: string;
    readonly sameSite: "Strict";
    readonly secure: true;
    readonly url: string;
    readonly value: string;
  }[];
  readonly formats: readonly HostedBrowserSnapshotFormat[];
  readonly gotoOptions: { readonly waitUntil: "networkidle0" };
  readonly rejectResourceTypes?: readonly HostedBrowserRejectedResourceType[];
  readonly screenshotOptions?: {
    readonly quality: 80;
    readonly type: "webp";
  };
  readonly url: string;
  readonly viewport: typeof HOSTED_BROWSER_VIEWPORT;
  readonly waitForSelector?: {
    readonly selector: string;
    readonly timeout: number;
  };
}

type HostedBrowserContentRequest = Omit<
  HostedBrowserSnapshotRequest,
  "formats" | "screenshotOptions"
>;

interface HostedBrowserSnapshot {
  readonly content: string;
  readonly screenshot?: string;
}

interface RenderHostedBrowserSnapshotArgs {
  readonly actionTimeout?: number;
  readonly formats: readonly HostedBrowserSnapshotFormat[];
  readonly rejectResourceTypes?: readonly HostedBrowserRejectedResourceType[];
  readonly token: string;
  readonly url: string;
  readonly wafSecret: string;
  readonly waitForSelector?: {
    readonly selector: string;
    readonly timeout: number;
  };
}

type RenderHostedBrowserContentArgs = Omit<
  RenderHostedBrowserSnapshotArgs,
  "formats"
>;

export class HostedBrowserRenderingError extends Error {
  override readonly name = "HostedBrowserRenderingError";
}

function hostedBrowserRequest(
  args: RenderHostedBrowserContentArgs,
): HostedBrowserContentRequest {
  const previewUrl = new URL(args.url);
  const hostDomain = env("ZERO_HOST_DOMAIN");
  if (
    previewUrl.protocol !== "https:" ||
    !previewUrl.hostname.endsWith(`.${hostDomain}`)
  ) {
    throw new Error(
      `artifact preview URL must be a subdomain of ${hostDomain}`,
    );
  }

  return {
    actionTimeout: args.actionTimeout,
    bestAttempt: args.waitForSelector ? true : undefined,
    url: args.url,
    cookies: [
      {
        name: HOSTED_BROWSER_WAF_COOKIE_NAME,
        value: args.wafSecret,
        url: previewUrl.origin,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ],
    viewport: HOSTED_BROWSER_VIEWPORT,
    gotoOptions: { waitUntil: "networkidle0" },
    rejectResourceTypes: args.rejectResourceTypes,
    waitForSelector: args.waitForSelector,
  };
}

function isCloudflareChallenge(content: string, title?: string): boolean {
  const page = `${title ?? ""}\n${content}`.toLowerCase();
  const hasChallengeCopy = [
    "performing security verification",
    "incompatible browser extension or network configuration",
    "verify you are human",
    "checking your browser",
    "just a moment",
  ].some((marker) => {
    return page.includes(marker);
  });
  const hasChallengeImplementation = [
    "challenges.cloudflare.com",
    "/cdn-cgi/challenge-platform/",
    "challenge-platform",
    "cf-chl-",
    "__cf_chl_",
  ].some((marker) => {
    return page.includes(marker);
  });
  return hasChallengeCopy && hasChallengeImplementation;
}

export async function renderHostedBrowserSnapshot(
  args: RenderHostedBrowserSnapshotArgs,
  signal: AbortSignal,
): Promise<HostedBrowserSnapshot> {
  const requestBody: HostedBrowserSnapshotRequest = {
    ...hostedBrowserRequest(args),
    formats: args.formats,
    screenshotOptions: args.formats.includes("screenshot")
      ? { type: "webp", quality: 80 }
      : undefined,
  };

  const accountId = env("R2_ACCOUNT_ID");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/snapshot?cacheTTL=0`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    },
  );
  if (!response.ok) {
    throw new HostedBrowserRenderingError(
      `browser-rendering snapshot failed (${response.status}): ${await response.text()}`,
    );
  }

  const responseBody: unknown = await response.json();
  const snapshot = browserSnapshotSchema.parse(responseBody);
  if (snapshot.meta.status !== undefined && snapshot.meta.status >= 400) {
    throw new HostedBrowserRenderingError(
      `browser-rendering snapshot returned page status ${snapshot.meta.status}`,
    );
  }
  if (isCloudflareChallenge(snapshot.result.content, snapshot.meta.title)) {
    throw new HostedBrowserRenderingError(
      "browser-rendering snapshot returned a Cloudflare challenge",
    );
  }
  return snapshot.result;
}

export async function renderHostedBrowserContent(
  args: RenderHostedBrowserContentArgs,
  signal: AbortSignal,
): Promise<string> {
  const accountId = env("R2_ACCOUNT_ID");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/content?cacheTTL=0`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(hostedBrowserRequest(args)),
      signal,
    },
  );
  if (!response.ok) {
    throw new HostedBrowserRenderingError(
      `browser-rendering content failed (${response.status}): ${await response.text()}`,
    );
  }

  const responseBody: unknown = await response.json();
  const content = browserContentSchema.parse(responseBody);
  if (content.meta.status !== undefined && content.meta.status >= 400) {
    throw new HostedBrowserRenderingError(
      `browser-rendering content returned page status ${content.meta.status}`,
    );
  }
  if (isCloudflareChallenge(content.result, content.meta.title)) {
    throw new HostedBrowserRenderingError(
      "browser-rendering content returned a Cloudflare challenge",
    );
  }
  return content.result;
}
