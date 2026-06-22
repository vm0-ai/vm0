/**
 * Generate the YouTube firewall config.
 *
 * YouTube Discovery method scopes are OAuth authorization constraints, not vm0
 * firewall permission groups. Keep route coverage official by loading YouTube
 * v3 Discovery, but keep the firewall permission taxonomy explicit here.
 */

import { fetchSpec, logStats, writeOutput } from "./codegen";
import {
  compileGoogleManifestFirewall,
  renderGoogleManifestFirewall,
  validateGoogleManifestPermissionManifest,
} from "./google-manifest";
import type { GoogleManifestPermission } from "./google-manifest";

const YOUTUBE_ROUTE_KEY_KINDS = ["base", "upload", "resumable-upload"] as const;
type YouTubeRouteKeyKind = (typeof YOUTUBE_ROUTE_KEY_KINDS)[number];

interface DiscoveryMethod {
  id?: string;
  httpMethod?: string;
  path?: string;
  flatPath?: string;
  supportsMediaUpload?: boolean;
  mediaUpload?: {
    protocols?: {
      simple?: DiscoveryMediaUploadProtocol;
      resumable?: DiscoveryMediaUploadProtocol;
    };
  };
}

interface DiscoveryMediaUploadProtocol {
  path?: string;
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface YouTubeDiscoveryDocument {
  version?: string;
  resources?: Record<string, DiscoveryResource>;
}

export interface YouTubeManifestPermission extends GoogleManifestPermission {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly routeKeys: readonly string[];
}

export const YOUTUBE_DISCOVERY_URL =
  "https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest";

const YOUTUBE_BASE_URL = "https://youtube.googleapis.com/youtube";
const YOUTUBE_UPLOAD_BASE_URL = "https://youtube.googleapis.com/upload/youtube";
const YOUTUBE_RESUMABLE_UPLOAD_BASE_URL =
  "https://youtube.googleapis.com/resumable/upload/youtube";
const YOUTUBE_TOKEN_PLACEHOLDER =
  "ya29.A0CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSa";

const DEFAULT_ALLOWED_YOUTUBE_PERMISSIONS = [
  "activities.read",
  "captions.download",
  "captions.read",
  "channel-sections.read",
  "channels.read",
  "comment-threads.read",
  "comments.read",
  "i18n-languages.read",
  "i18n-regions.read",
  "live-broadcasts.read",
  "live-chat-messages.read",
  "live-chat-moderators.read",
  "live-streams.read",
  "playlist-images.read",
  "playlist-items.read",
  "playlists.read",
  "search.read",
  "subscriptions.read",
  "super-chat-events.read",
  "video-abuse-report-reasons.read",
  "video-categories.read",
  "video-trainability.read",
  "videos.rating.read",
  "videos.read",
];

const YOUTUBE_CATEGORY_ORDER = [
  "Channels",
  "Videos",
  "Comments & Captions",
  "Playlists",
  "Live Streaming",
  "Live Chat",
  "Subscriptions",
  "Memberships & Monetization",
  "Discovery",
  "Third Party Links",
  "Tests",
] as const;

export const YOUTUBE_PERMISSION_MANIFEST: readonly YouTubeManifestPermission[] =
  [
    {
      name: "activities.read",
      category: "Channels",
      description: "Read YouTube channel activities.",
      routeKeys: ["base:GET /v3/activities"],
    },
    {
      name: "channel-banners.upload",
      category: "Channels",
      description: "Upload YouTube channel banners.",
      routeKeys: [
        "base:POST /v3/channelBanners/insert",
        "upload:POST /v3/channelBanners/insert",
        "resumable-upload:POST /v3/channelBanners/insert",
      ],
    },
    {
      name: "channel-sections.delete",
      category: "Channels",
      description: "Delete YouTube channel sections.",
      routeKeys: ["base:DELETE /v3/channelSections"],
    },
    {
      name: "channel-sections.read",
      category: "Channels",
      description: "Read YouTube channel sections.",
      routeKeys: ["base:GET /v3/channelSections"],
    },
    {
      name: "channel-sections.write",
      category: "Channels",
      description: "Create and update YouTube channel sections.",
      routeKeys: [
        "base:POST /v3/channelSections",
        "base:PUT /v3/channelSections",
      ],
    },
    {
      name: "channels.read",
      category: "Channels",
      description: "Read YouTube channels.",
      routeKeys: ["base:GET /v3/channels"],
    },
    {
      name: "channels.write",
      category: "Channels",
      description: "Update YouTube channels.",
      routeKeys: ["base:PUT /v3/channels"],
    },
    {
      name: "abuse-reports.create",
      category: "Videos",
      description: "Create YouTube abuse reports.",
      routeKeys: ["base:POST /v3/abuseReports"],
    },
    {
      name: "thumbnails.set",
      category: "Videos",
      description: "Set YouTube video thumbnails.",
      routeKeys: [
        "base:POST /v3/thumbnails/set",
        "upload:POST /v3/thumbnails/set",
        "resumable-upload:POST /v3/thumbnails/set",
      ],
    },
    {
      name: "video-abuse-report-reasons.read",
      category: "Videos",
      description: "Read YouTube video abuse report reasons.",
      routeKeys: ["base:GET /v3/videoAbuseReportReasons"],
    },
    {
      name: "video-categories.read",
      category: "Videos",
      description: "Read YouTube video categories.",
      routeKeys: ["base:GET /v3/videoCategories"],
    },
    {
      name: "video-trainability.read",
      category: "Videos",
      description: "Read YouTube video trainability state.",
      routeKeys: ["base:GET /v3/videoTrainability"],
    },
    {
      name: "videos.create",
      category: "Videos",
      description: "Upload YouTube videos.",
      routeKeys: [
        "base:POST /v3/videos",
        "upload:POST /v3/videos",
        "resumable-upload:POST /v3/videos",
      ],
    },
    {
      name: "videos.delete",
      category: "Videos",
      description: "Delete YouTube videos.",
      routeKeys: ["base:DELETE /v3/videos"],
    },
    {
      name: "videos.rating.read",
      category: "Videos",
      description: "Read YouTube video ratings.",
      routeKeys: ["base:GET /v3/videos/getRating"],
    },
    {
      name: "videos.rate",
      category: "Videos",
      description: "Rate YouTube videos.",
      routeKeys: ["base:POST /v3/videos/rate"],
    },
    {
      name: "videos.read",
      category: "Videos",
      description: "Read YouTube videos.",
      routeKeys: ["base:GET /v3/videos"],
    },
    {
      name: "videos.report-abuse",
      category: "Videos",
      description: "Report YouTube video abuse.",
      routeKeys: ["base:POST /v3/videos/reportAbuse"],
    },
    {
      name: "videos.write",
      category: "Videos",
      description: "Update YouTube videos.",
      routeKeys: ["base:PUT /v3/videos"],
    },
    {
      name: "watermarks.delete",
      category: "Videos",
      description: "Remove YouTube channel watermarks.",
      routeKeys: ["base:POST /v3/watermarks/unset"],
    },
    {
      name: "watermarks.set",
      category: "Videos",
      description: "Set YouTube channel watermarks.",
      routeKeys: [
        "base:POST /v3/watermarks/set",
        "upload:POST /v3/watermarks/set",
        "resumable-upload:POST /v3/watermarks/set",
      ],
    },
    {
      name: "captions.delete",
      category: "Comments & Captions",
      description: "Delete YouTube captions.",
      routeKeys: ["base:DELETE /v3/captions"],
    },
    {
      name: "captions.download",
      category: "Comments & Captions",
      description: "Download YouTube captions.",
      routeKeys: ["base:GET /v3/captions/{id}"],
    },
    {
      name: "captions.read",
      category: "Comments & Captions",
      description: "Read YouTube captions.",
      routeKeys: ["base:GET /v3/captions"],
    },
    {
      name: "captions.write",
      category: "Comments & Captions",
      description: "Create and update YouTube captions.",
      routeKeys: [
        "base:POST /v3/captions",
        "base:PUT /v3/captions",
        "upload:POST /v3/captions",
        "upload:PUT /v3/captions",
        "resumable-upload:POST /v3/captions",
        "resumable-upload:PUT /v3/captions",
      ],
    },
    {
      name: "comment-threads.read",
      category: "Comments & Captions",
      description: "Read YouTube comment threads.",
      routeKeys: ["base:GET /v3/commentThreads"],
    },
    {
      name: "comment-threads.write",
      category: "Comments & Captions",
      description: "Create and update YouTube comment threads.",
      routeKeys: [
        "base:POST /v3/commentThreads",
        "base:PUT /v3/commentThreads",
      ],
    },
    {
      name: "comments.delete",
      category: "Comments & Captions",
      description: "Delete YouTube comments.",
      routeKeys: ["base:DELETE /v3/comments"],
    },
    {
      name: "comments.moderate",
      category: "Comments & Captions",
      description: "Moderate YouTube comments.",
      routeKeys: [
        "base:POST /v3/comments/markAsSpam",
        "base:POST /v3/comments/setModerationStatus",
      ],
    },
    {
      name: "comments.read",
      category: "Comments & Captions",
      description: "Read YouTube comments.",
      routeKeys: ["base:GET /v3/comments"],
    },
    {
      name: "comments.write",
      category: "Comments & Captions",
      description: "Create and update YouTube comments.",
      routeKeys: ["base:POST /v3/comments", "base:PUT /v3/comments"],
    },
    {
      name: "playlist-images.delete",
      category: "Playlists",
      description: "Delete YouTube playlist images.",
      routeKeys: ["base:DELETE /v3/playlistImages"],
    },
    {
      name: "playlist-images.read",
      category: "Playlists",
      description: "Read YouTube playlist images.",
      routeKeys: ["base:GET /v3/playlistImages"],
    },
    {
      name: "playlist-images.write",
      category: "Playlists",
      description: "Create and update YouTube playlist images.",
      routeKeys: [
        "base:POST /v3/playlistImages",
        "base:PUT /v3/playlistImages",
        "upload:POST /v3/playlistImages",
        "upload:PUT /v3/playlistImages",
        "resumable-upload:POST /v3/playlistImages",
        "resumable-upload:PUT /v3/playlistImages",
      ],
    },
    {
      name: "playlist-items.delete",
      category: "Playlists",
      description: "Delete YouTube playlist items.",
      routeKeys: ["base:DELETE /v3/playlistItems"],
    },
    {
      name: "playlist-items.read",
      category: "Playlists",
      description: "Read YouTube playlist items.",
      routeKeys: ["base:GET /v3/playlistItems"],
    },
    {
      name: "playlist-items.write",
      category: "Playlists",
      description: "Create and update YouTube playlist items.",
      routeKeys: ["base:POST /v3/playlistItems", "base:PUT /v3/playlistItems"],
    },
    {
      name: "playlists.delete",
      category: "Playlists",
      description: "Delete YouTube playlists.",
      routeKeys: ["base:DELETE /v3/playlists"],
    },
    {
      name: "playlists.read",
      category: "Playlists",
      description: "Read YouTube playlists.",
      routeKeys: ["base:GET /v3/playlists"],
    },
    {
      name: "playlists.write",
      category: "Playlists",
      description: "Create and update YouTube playlists.",
      routeKeys: ["base:POST /v3/playlists", "base:PUT /v3/playlists"],
    },
    {
      name: "live-broadcasts.control",
      category: "Live Streaming",
      description: "Bind, cue, and transition YouTube live broadcasts.",
      routeKeys: [
        "base:POST /v3/liveBroadcasts/bind",
        "base:POST /v3/liveBroadcasts/cuepoint",
        "base:POST /v3/liveBroadcasts/transition",
      ],
    },
    {
      name: "live-broadcasts.create",
      category: "Live Streaming",
      description: "Create YouTube live broadcasts.",
      routeKeys: ["base:POST /v3/liveBroadcasts"],
    },
    {
      name: "live-broadcasts.delete",
      category: "Live Streaming",
      description: "Delete YouTube live broadcasts.",
      routeKeys: ["base:DELETE /v3/liveBroadcasts"],
    },
    {
      name: "live-broadcasts.read",
      category: "Live Streaming",
      description: "Read YouTube live broadcasts.",
      routeKeys: ["base:GET /v3/liveBroadcasts"],
    },
    {
      name: "live-broadcasts.write",
      category: "Live Streaming",
      description: "Update YouTube live broadcasts.",
      routeKeys: ["base:PUT /v3/liveBroadcasts"],
    },
    {
      name: "live-streams.create",
      category: "Live Streaming",
      description: "Create YouTube live streams.",
      routeKeys: ["base:POST /v3/liveStreams"],
    },
    {
      name: "live-streams.delete",
      category: "Live Streaming",
      description: "Delete YouTube live streams.",
      routeKeys: ["base:DELETE /v3/liveStreams"],
    },
    {
      name: "live-streams.read",
      category: "Live Streaming",
      description: "Read YouTube live streams.",
      routeKeys: ["base:GET /v3/liveStreams"],
    },
    {
      name: "live-streams.write",
      category: "Live Streaming",
      description: "Update YouTube live streams.",
      routeKeys: ["base:PUT /v3/liveStreams"],
    },
    {
      name: "live-chat-bans.write",
      category: "Live Chat",
      description: "Create and delete YouTube live chat bans.",
      routeKeys: [
        "base:POST /v3/liveChat/bans",
        "base:DELETE /v3/liveChat/bans",
      ],
    },
    {
      name: "live-chat-messages.delete",
      category: "Live Chat",
      description: "Delete YouTube live chat messages.",
      routeKeys: ["base:DELETE /v3/liveChat/messages"],
    },
    {
      name: "live-chat-messages.read",
      category: "Live Chat",
      description: "Read YouTube live chat messages.",
      routeKeys: [
        "base:GET /v3/liveChat/messages",
        "base:GET /v3/liveChat/messages/stream",
      ],
    },
    {
      name: "live-chat-messages.write",
      category: "Live Chat",
      description: "Create and transition YouTube live chat messages.",
      routeKeys: [
        "base:POST /v3/liveChat/messages",
        "base:POST /v3/liveChat/messages/transition",
      ],
    },
    {
      name: "live-chat-moderators.read",
      category: "Live Chat",
      description: "Read YouTube live chat moderators.",
      routeKeys: ["base:GET /v3/liveChat/moderators"],
    },
    {
      name: "live-chat-moderators.write",
      category: "Live Chat",
      description: "Create and delete YouTube live chat moderators.",
      routeKeys: [
        "base:POST /v3/liveChat/moderators",
        "base:DELETE /v3/liveChat/moderators",
      ],
    },
    {
      name: "subscriptions.delete",
      category: "Subscriptions",
      description: "Delete YouTube subscriptions.",
      routeKeys: ["base:DELETE /v3/subscriptions"],
    },
    {
      name: "subscriptions.read",
      category: "Subscriptions",
      description: "Read YouTube subscriptions.",
      routeKeys: ["base:GET /v3/subscriptions"],
    },
    {
      name: "subscriptions.write",
      category: "Subscriptions",
      description: "Create YouTube subscriptions.",
      routeKeys: ["base:POST /v3/subscriptions"],
    },
    {
      name: "members.read",
      category: "Memberships & Monetization",
      description: "Read YouTube channel members.",
      routeKeys: ["base:GET /v3/members"],
    },
    {
      name: "membership-levels.read",
      category: "Memberships & Monetization",
      description: "Read YouTube channel membership levels.",
      routeKeys: ["base:GET /v3/membershipsLevels"],
    },
    {
      name: "super-chat-events.read",
      category: "Memberships & Monetization",
      description: "Read YouTube Super Chat events.",
      routeKeys: ["base:GET /v3/superChatEvents"],
    },
    {
      name: "i18n-languages.read",
      category: "Discovery",
      description: "Read YouTube supported interface languages.",
      routeKeys: ["base:GET /v3/i18nLanguages"],
    },
    {
      name: "i18n-regions.read",
      category: "Discovery",
      description: "Read YouTube supported regions.",
      routeKeys: ["base:GET /v3/i18nRegions"],
    },
    {
      name: "search.read",
      category: "Discovery",
      description: "Search YouTube resources.",
      routeKeys: ["base:GET /v3/search"],
    },
    {
      name: "third-party-links.delete",
      category: "Third Party Links",
      description: "Delete YouTube third-party links.",
      routeKeys: ["base:DELETE /v3/thirdPartyLinks"],
    },
    {
      name: "third-party-links.read",
      category: "Third Party Links",
      description: "Read YouTube third-party links.",
      routeKeys: ["base:GET /v3/thirdPartyLinks"],
    },
    {
      name: "third-party-links.write",
      category: "Third Party Links",
      description: "Create and update YouTube third-party links.",
      routeKeys: [
        "base:POST /v3/thirdPartyLinks",
        "base:PUT /v3/thirdPartyLinks",
      ],
    },
    {
      name: "tests.create",
      category: "Tests",
      description: "Create YouTube API test resources.",
      routeKeys: ["base:POST /v3/tests"],
    },
  ];

function extractMethods(
  resources: Record<string, DiscoveryResource>,
): DiscoveryMethod[] {
  const methods: DiscoveryMethod[] = [];
  for (const resource of Object.values(resources)) {
    if (resource.methods) {
      methods.push(...Object.values(resource.methods));
    }
    if (resource.resources) {
      methods.push(...extractMethods(resource.resources));
    }
  }
  return methods;
}

function normalizeYouTubePath(path: string): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  if (normalized.startsWith("youtube/")) {
    return normalized.slice("youtube/".length);
  }
  return normalized;
}

function normalizeYouTubeUploadPath(
  path: string,
  uploadPrefix: "upload" | "resumable-upload",
): string {
  const normalized = path.startsWith("/") ? path.slice(1) : path;
  const discoveryPrefix =
    uploadPrefix === "upload" ? "upload/youtube/" : "resumable/upload/youtube/";
  if (!normalized.startsWith(discoveryPrefix)) {
    throw new Error(`YouTube upload path has unexpected prefix: ${path}`);
  }
  return normalized.slice(discoveryPrefix.length);
}

function ruleForMethod(method: DiscoveryMethod): string {
  const httpMethod = method.httpMethod;
  const methodPath = method.flatPath ?? method.path;
  if (!httpMethod || !methodPath) {
    throw new Error(
      `YouTube method missing httpMethod or path: ${method.id ?? "unknown"}`,
    );
  }
  return `${httpMethod.toUpperCase()} /${normalizeYouTubePath(methodPath)}`;
}

function uploadRuleForMethod(
  method: DiscoveryMethod,
  protocol: DiscoveryMediaUploadProtocol | undefined,
  uploadPrefix: "upload" | "resumable-upload",
): string | null {
  if (!protocol) return null;

  const httpMethod = method.httpMethod;
  const protocolPath = protocol.path;
  if (!httpMethod || !protocolPath) {
    throw new Error(
      `YouTube upload method missing httpMethod or upload path: ${method.id ?? "unknown"}`,
    );
  }

  return `${httpMethod.toUpperCase()} /${normalizeYouTubeUploadPath(
    protocolPath,
    uploadPrefix,
  )}`;
}

export function buildYouTubeOfficialRouteKeys(
  discovery: YouTubeDiscoveryDocument,
): Set<string> {
  const routeKeys = new Set<string>();
  console.error(`  API version: ${discovery.version ?? "unknown"}`);
  for (const method of extractMethods(discovery.resources ?? {})) {
    const rule = ruleForMethod(method);
    routeKeys.add(`base:${rule}`);
    if (method.supportsMediaUpload === true) {
      const simpleRule = uploadRuleForMethod(
        method,
        method.mediaUpload?.protocols?.simple,
        "upload",
      );
      if (simpleRule) {
        routeKeys.add(`upload:${simpleRule}`);
      }

      const resumableRule = uploadRuleForMethod(
        method,
        method.mediaUpload?.protocols?.resumable,
        "resumable-upload",
      );
      if (resumableRule) {
        routeKeys.add(`resumable-upload:${resumableRule}`);
      }

      if (!simpleRule && !resumableRule) {
        throw new Error(
          `YouTube upload method missing upload protocols: ${method.id ?? rule}`,
        );
      }
    }
  }
  return routeKeys;
}

export function validateYouTubePermissionManifest(
  officialRouteKeys: ReadonlySet<string>,
  manifest: readonly YouTubeManifestPermission[],
): void {
  validateGoogleManifestPermissionManifest({
    serviceLabel: "YouTube",
    routeKinds: YOUTUBE_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest,
    categoryOrder: YOUTUBE_CATEGORY_ORDER,
  });
}

async function loadYouTubeDiscovery(): Promise<YouTubeDiscoveryDocument> {
  const res = await fetchSpec(
    YOUTUBE_DISCOVERY_URL,
    "youtube discovery document",
  );
  return (await res.json()) as YouTubeDiscoveryDocument;
}

export async function generate(): Promise<void> {
  const discovery = await loadYouTubeDiscovery();
  const officialRouteKeys = buildYouTubeOfficialRouteKeys(discovery);
  const compiled = compileGoogleManifestFirewall<
    YouTubeRouteKeyKind,
    YouTubeManifestPermission
  >({
    serviceLabel: "YouTube",
    routeKinds: YOUTUBE_ROUTE_KEY_KINDS,
    officialRouteKeys,
    manifest: YOUTUBE_PERMISSION_MANIFEST,
    apis: [
      {
        base: YOUTUBE_BASE_URL,
        kind: "base",
      },
      {
        base: YOUTUBE_UPLOAD_BASE_URL,
        kind: "upload",
      },
      {
        base: YOUTUBE_RESUMABLE_UPLOAD_BASE_URL,
        kind: "resumable-upload",
      },
    ],
    categoryOrder: YOUTUBE_CATEGORY_ORDER,
  });
  if (!compiled.categories) {
    throw new Error("YouTube categories were not compiled");
  }

  const ts = renderGoogleManifestFirewall({
    headerLines: [
      "// Auto-generated from Google's YouTube Discovery API and vm0's YouTube permission manifest.",
      `// Source: ${YOUTUBE_DISCOVERY_URL}`,
      "// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:youtube",
      "//",
      "// DO NOT EDIT THIS FILE MANUALLY.",
    ],
    firewallVarName: "youtubeFirewall",
    firewallName: "youtube",
    firewallDescription: "YouTube Data API",
    tokenPlaceholderName: "YOUTUBE_TOKEN",
    tokenPlaceholderValue: YOUTUBE_TOKEN_PLACEHOLDER,
    apis: compiled.apis,
    defaultAllowed: {
      varName: "youtubeDefaultAllowed",
      permissions: DEFAULT_ALLOWED_YOUTUBE_PERMISSIONS,
    },
    defaultUnknownPolicy: {
      varName: "youtubeDefaultUnknownPolicy",
      policy: "deny",
    },
    categories: {
      varName: "youtubeCategories",
      config: compiled.categories,
    },
  });
  logStats(
    YOUTUBE_PERMISSION_MANIFEST.map((permission) => {
      return { ...permission, rules: [...permission.routeKeys] };
    }),
  );
  writeOutput("youtube", ts, import.meta.dirname);
}
