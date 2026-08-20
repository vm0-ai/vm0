import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const SOCIALKIT_MAX_PATH_CHARS = 128;
export const SOCIALKIT_MAX_QUERY_ENTRIES = 16;
export const SOCIALKIT_MAX_QUERY_VALUE_CHARS = 4_096;
export const SOCIALKIT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const SOCIALKIT_MAX_BULK_ITEMS = 100;

export type SocialKitRequestMethod = "GET" | "POST";

export interface ManagedSocialKitOperation {
  readonly method: SocialKitRequestMethod;
  readonly path: string;
  readonly category: string;
  readonly bulk: boolean;
  readonly queryNames: readonly string[];
}

interface SocialKitPathConfig {
  readonly path: string;
  readonly category: string;
}

interface SocialKitPairedPathConfig extends SocialKitPathConfig {
  readonly queryNames: readonly string[];
}

const URL_QUERY_NAMES = ["url"] as const;
const URL_LIMIT_QUERY_NAMES = ["url", "limit"] as const;
const SEARCH_QUERY_NAMES = ["query", "limit"] as const;

const PAIRED_PATHS: readonly SocialKitPairedPathConfig[] = [
  {
    path: "/linkedin/profile",
    category: "linkedin.profiles.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/linkedin/company",
    category: "linkedin.companies.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/linkedin/company-posts",
    category: "linkedin.company-posts.extract",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/linkedin/post",
    category: "linkedin.posts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/linkedin/transcript",
    category: "linkedin.transcripts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/twitter/profile",
    category: "twitter.profiles.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/twitter/tweets",
    category: "twitter.timelines.extract",
    queryNames: ["url", "limit", "cursor"],
  },
  {
    path: "/twitter/tweet",
    category: "twitter.posts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/twitter/thread",
    category: "twitter.threads.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/twitter/transcript",
    category: "twitter.transcripts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/facebook/stats",
    category: "facebook.post-stats.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/facebook/channel-stats",
    category: "facebook.page-stats.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/facebook/transcript",
    category: "facebook.transcripts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/facebook/comments",
    category: "facebook.comments.extract",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/facebook/summarize",
    category: "facebook.summaries.generate",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/instagram/stats",
    category: "instagram.post-stats.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/instagram/channel-stats",
    category: "instagram.channel-stats.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/instagram/transcript",
    category: "instagram.transcripts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/instagram/comments",
    category: "instagram.comments.extract",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/instagram/channel-posts",
    category: "instagram.channel-posts.extract",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/instagram/channel-reels",
    category: "instagram.channel-reels.extract",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/instagram/reels-search",
    category: "instagram.reels-search",
    queryNames: SEARCH_QUERY_NAMES,
  },
  {
    path: "/instagram/summarize",
    category: "instagram.summaries.generate",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/tiktok/stats",
    category: "tiktok.video-stats.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/tiktok/comments",
    category: "tiktok.comments.extract",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/tiktok/transcript",
    category: "tiktok.transcripts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/tiktok/channel-stats",
    category: "tiktok.channel-stats.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/tiktok/channel-videos",
    category: "tiktok.channel-videos.extract",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/tiktok/search",
    category: "tiktok.search",
    queryNames: SEARCH_QUERY_NAMES,
  },
  {
    path: "/tiktok/hashtag-search",
    category: "tiktok.hashtag-search",
    queryNames: ["hashtag", "limit"],
  },
  {
    path: "/tiktok/summarize",
    category: "tiktok.summaries.generate",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/youtube/transcript",
    category: "youtube.transcripts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/youtube/stats",
    category: "youtube.video-stats.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/youtube/comments",
    category: "youtube.comments.extract",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/youtube/channel-stats",
    category: "youtube.channel-stats.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/youtube/search",
    category: "youtube.search",
    queryNames: SEARCH_QUERY_NAMES,
  },
  {
    path: "/youtube/videos",
    category: "youtube.videos.extract",
    queryNames: ["url", "limit", "full_details"],
  },
  {
    path: "/youtube/summarize",
    category: "youtube.summaries.generate",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/video/transcript",
    category: "video.transcripts.extract",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/video/summarize",
    category: "video.summaries.generate",
    queryNames: URL_QUERY_NAMES,
  },
];

const BULK_PATHS: readonly SocialKitPathConfig[] = [
  {
    path: "/youtube/transcript/bulk",
    category: "youtube.transcripts.extract",
  },
  {
    path: "/youtube/comments/bulk",
    category: "youtube.comments.extract",
  },
  { path: "/youtube/stats/bulk", category: "youtube.video-stats.extract" },
  {
    path: "/youtube/summarize/bulk",
    category: "youtube.summaries.generate",
  },
  {
    path: "/tiktok/transcript/bulk",
    category: "tiktok.transcripts.extract",
  },
  { path: "/tiktok/comments/bulk", category: "tiktok.comments.extract" },
  { path: "/tiktok/stats/bulk", category: "tiktok.video-stats.extract" },
  {
    path: "/tiktok/channel-stats/bulk",
    category: "tiktok.channel-stats.extract",
  },
  {
    path: "/tiktok/summarize/bulk",
    category: "tiktok.summaries.generate",
  },
  {
    path: "/instagram/transcript/bulk",
    category: "instagram.transcripts.extract",
  },
  {
    path: "/instagram/stats/bulk",
    category: "instagram.post-stats.extract",
  },
  {
    path: "/instagram/channel-stats/bulk",
    category: "instagram.channel-stats.extract",
  },
  {
    path: "/instagram/summarize/bulk",
    category: "instagram.summaries.generate",
  },
];

export const MANAGED_SOCIALKIT_OPERATIONS: readonly ManagedSocialKitOperation[] =
  [
    ...PAIRED_PATHS.flatMap((operation): ManagedSocialKitOperation[] => {
      return [
        { ...operation, method: "GET", bulk: false },
        { ...operation, method: "POST", bulk: false },
      ];
    }),
    ...BULK_PATHS.map((operation): ManagedSocialKitOperation => {
      return {
        ...operation,
        method: "POST",
        bulk: true,
        queryNames: [],
      };
    }),
  ];

export const MANAGED_SOCIALKIT_BILLING_CATEGORIES: readonly string[] = [
  ...new Set(
    PAIRED_PATHS.map((operation) => {
      return operation.category;
    }),
  ),
];

export function findManagedSocialKitOperation(
  method: SocialKitRequestMethod,
  path: string,
): ManagedSocialKitOperation | undefined {
  return MANAGED_SOCIALKIT_OPERATIONS.find((operation) => {
    return operation.method === method && operation.path === path;
  });
}

function hasSafeUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password
  );
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const queryValueSchema = z.string().max(SOCIALKIT_MAX_QUERY_VALUE_CHARS);

const socialKitQuerySchema = z
  .record(z.string().min(1).max(64), queryValueSchema)
  .refine(
    (query) => {
      return Object.keys(query).length <= SOCIALKIT_MAX_QUERY_ENTRIES;
    },
    {
      message: `Query accepts at most ${SOCIALKIT_MAX_QUERY_ENTRIES} fields`,
    },
  )
  .refine(
    (query) => {
      return query.url === undefined || hasSafeUrl(query.url);
    },
    {
      message: "url must be an HTTP(S) URL without embedded credentials",
    },
  );

const socialKitBodySchema = z
  .object({
    urls: z.array(z.string()).min(1).max(SOCIALKIT_MAX_BULK_ITEMS),
  })
  .strict()
  .refine(
    (body) => {
      return byteLength(body) <= SOCIALKIT_MAX_REQUEST_BODY_BYTES;
    },
    {
      message: `JSON body exceeds ${SOCIALKIT_MAX_REQUEST_BODY_BYTES} bytes`,
    },
  );

function validateBodyUrls(
  body: { readonly urls: readonly string[] },
  context: z.RefinementCtx,
): void {
  if (!body.urls.every(hasSafeUrl)) {
    context.addIssue({
      code: "custom",
      path: ["body", "urls"],
      message: `urls must contain 1-${SOCIALKIT_MAX_BULK_ITEMS} HTTP(S) URLs without embedded credentials`,
    });
  }
}

export const socialKitRequestSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1).max(SOCIALKIT_MAX_PATH_CHARS),
    query: socialKitQuerySchema.optional(),
    body: socialKitBodySchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const operation = findManagedSocialKitOperation(
      request.method,
      request.path,
    );
    if (!operation) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "Method and path are not a reviewed SocialKit operation",
      });
      return;
    }
    if (
      request.query &&
      Object.keys(request.query).some((name) => {
        return !operation.queryNames.includes(name);
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "Query contains a field not reviewed for this operation",
      });
    }
    if (request.body) {
      validateBodyUrls(request.body, context);
    }
    if (operation.bulk) {
      if (!request.body || !Array.isArray(request.body.urls)) {
        context.addIssue({
          code: "custom",
          path: ["body", "urls"],
          message: "Bulk operations require a JSON urls array",
        });
      }
    } else if (request.body !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "JSON body is accepted only by bulk operations",
      });
    }
  });

export const socialKitResponseSchema = z.object({
  provider: z.literal("socialkit"),
  operation: z.object({
    method: z.enum(["GET", "POST"]),
    path: z.string(),
  }),
  billingCategory: z.string(),
  billingQuantity: z.number().int().positive(),
  creditsCharged: z.number().int().nonnegative(),
  result: z.unknown(),
});

export type SocialKitRequest = z.infer<typeof socialKitRequestSchema>;
export type SocialKitResponse = z.infer<typeof socialKitResponseSchema>;

export const socialContract = c.router({
  request: {
    method: "POST",
    path: "/api/okou/social/request",
    headers: authHeadersSchema,
    body: socialKitRequestSchema,
    responses: {
      200: socialKitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Call a reviewed managed SocialKit data or analysis operation",
  },
});

export type SocialContract = typeof socialContract;
