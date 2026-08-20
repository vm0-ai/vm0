import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const SOCIALKIT_MAX_PATH_CHARS = 128;
export const SOCIALKIT_MAX_QUERY_ENTRIES = 16;
export const SOCIALKIT_MAX_QUERY_VALUE_CHARS = 4_096;
export const MANAGED_SOCIALKIT_BILLING_CATEGORY = "request";

export type SocialKitRequestMethod = "GET" | "POST";

export interface ManagedSocialKitOperation {
  readonly method: SocialKitRequestMethod;
  readonly path: string;
  readonly queryNames: readonly string[];
  readonly maxLimit?: number;
}

interface SocialKitPathConfig {
  readonly path: string;
  readonly queryNames: readonly string[];
  readonly maxLimit?: number;
}

const URL_QUERY_NAMES = ["url"] as const;
const URL_LIMIT_QUERY_NAMES = ["url", "limit"] as const;
const SEARCH_QUERY_NAMES = ["query", "limit"] as const;

const PATHS: readonly SocialKitPathConfig[] = [
  {
    path: "/linkedin/profile",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/linkedin/company",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/linkedin/company-posts",
    queryNames: URL_LIMIT_QUERY_NAMES,
  },
  {
    path: "/linkedin/post",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/linkedin/transcript",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/twitter/profile",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/twitter/tweets",
    queryNames: ["url", "limit", "cursor"],
  },
  {
    path: "/twitter/tweet",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/twitter/thread",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/twitter/transcript",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/facebook/stats",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/facebook/channel-stats",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/facebook/transcript",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/facebook/comments",
    queryNames: URL_LIMIT_QUERY_NAMES,
    maxLimit: 50,
  },
  {
    path: "/facebook/summarize",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/instagram/stats",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/instagram/channel-stats",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/instagram/transcript",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/instagram/comments",
    queryNames: URL_LIMIT_QUERY_NAMES,
    maxLimit: 50,
  },
  {
    path: "/instagram/channel-posts",
    queryNames: URL_LIMIT_QUERY_NAMES,
    maxLimit: 20,
  },
  {
    path: "/instagram/channel-reels",
    queryNames: URL_LIMIT_QUERY_NAMES,
    maxLimit: 20,
  },
  {
    path: "/instagram/reels-search",
    queryNames: SEARCH_QUERY_NAMES,
  },
  {
    path: "/instagram/summarize",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/tiktok/stats",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/tiktok/comments",
    queryNames: URL_LIMIT_QUERY_NAMES,
    maxLimit: 50,
  },
  {
    path: "/tiktok/transcript",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/tiktok/channel-stats",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/tiktok/channel-videos",
    queryNames: URL_LIMIT_QUERY_NAMES,
    maxLimit: 50,
  },
  {
    path: "/tiktok/search",
    queryNames: SEARCH_QUERY_NAMES,
    maxLimit: 50,
  },
  {
    path: "/tiktok/hashtag-search",
    queryNames: ["hashtag", "limit"],
    maxLimit: 50,
  },
  {
    path: "/tiktok/summarize",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/youtube/transcript",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/youtube/stats",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/youtube/comments",
    queryNames: URL_LIMIT_QUERY_NAMES,
    maxLimit: 50,
  },
  {
    path: "/youtube/channel-stats",
    queryNames: URL_QUERY_NAMES,
  },
  {
    path: "/youtube/search",
    queryNames: SEARCH_QUERY_NAMES,
    maxLimit: 50,
  },
  {
    path: "/youtube/videos",
    queryNames: ["url", "limit", "full_details"],
    maxLimit: 50,
  },
  {
    path: "/youtube/summarize",
    queryNames: URL_QUERY_NAMES,
  },
];

export const MANAGED_SOCIALKIT_OPERATIONS: readonly ManagedSocialKitOperation[] =
  PATHS.flatMap((operation): ManagedSocialKitOperation[] => {
    return [
      { ...operation, method: "GET" },
      { ...operation, method: "POST" },
    ];
  });

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

function isBoundedLimit(value: string, maximum: number): boolean {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum;
}

export const socialKitRequestSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    path: z.string().min(1).max(SOCIALKIT_MAX_PATH_CHARS),
    query: socialKitQuerySchema.optional(),
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
    const limit = request.query?.limit;
    if (
      limit !== undefined &&
      operation.maxLimit !== undefined &&
      !isBoundedLimit(limit, operation.maxLimit)
    ) {
      context.addIssue({
        code: "custom",
        path: ["query", "limit"],
        message: `limit must be an integer from 1 to ${operation.maxLimit} for this operation`,
      });
    }
  });

export const socialKitResponseSchema = z.object({
  provider: z.literal("socialkit"),
  operation: z.object({
    method: z.enum(["GET", "POST"]),
    path: z.string(),
  }),
  billingCategory: z.literal(MANAGED_SOCIALKIT_BILLING_CATEGORY),
  billingQuantity: z.literal(1),
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
