import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const SOCIALKIT_MAX_PATH_CHARS = 128;
export const SOCIALKIT_MAX_QUERY_ENTRIES = 16;
export const SOCIALKIT_MAX_QUERY_VALUE_CHARS = 4_096;
export const MANAGED_SOCIALKIT_BILLING_CATEGORY = "request";

export type SocialKitRequestMethod = "GET" | "POST";

export type ManagedSocialKitResultField =
  | "comments"
  | "items"
  | "posts"
  | "results"
  | "tweets";

export type ManagedSocialKitPagination =
  | { readonly kind: "cursor" }
  | { readonly kind: "next_cursor" }
  | { readonly kind: "none" }
  | { readonly kind: "page"; readonly maxPage: number };

export interface ManagedSocialKitCollection {
  readonly resultField: ManagedSocialKitResultField;
  readonly defaultLimit?: number;
  readonly itemsPerBillingUnit?: number;
  readonly pagination: ManagedSocialKitPagination;
}

export interface ManagedSocialKitOperation {
  readonly method: SocialKitRequestMethod;
  readonly path: string;
  readonly queryNames: readonly string[];
  readonly maxLimit?: number;
  readonly collection?: ManagedSocialKitCollection;
}

interface SocialKitPathConfig {
  readonly path: string;
  readonly queryNames: readonly string[];
  readonly maxLimit?: number;
  readonly collection?: ManagedSocialKitCollection;
}

const CACHE_QUERY_NAMES = ["cache", "cache_ttl"] as const;
const URL_CACHE_QUERY_NAMES = ["url", ...CACHE_QUERY_NAMES] as const;
const URL_LIMIT_CURSOR_QUERY_NAMES = ["url", "limit", "cursor"] as const;
const SUMMARY_QUERY_NAMES = [
  "url",
  "custom_response",
  "custom_prompt",
  ...CACHE_QUERY_NAMES,
] as const;
const REQUIRED_QUERY_NAMES = ["url", "query", "hashtag"] as const;
const BOOLEAN_QUERY_NAMES = ["cache", "full_details"] as const;
const CACHE_TTL_MIN_SECONDS = 3_600;
const CACHE_TTL_MAX_SECONDS = 2_592_000;

const QUERY_VALUE_OPTIONS: Readonly<
  Partial<Record<string, Readonly<Record<string, readonly string[]>>>>
> = {
  "/instagram/comments": {
    sortBy: ["popular", "recent"],
  },
  "/tiktok/search": {
    sortBy: ["relevance", "likes", "date"],
    datePosted: ["day", "week", "month", "3months", "6months"],
  },
  "/youtube/comments": {
    sortBy: ["top", "new"],
  },
  "/youtube/search": {
    sortBy: ["relevance", "date", "views", "rating"],
    uploadDate: ["hour", "today", "week", "month", "year"],
    type: ["video", "shorts"],
  },
};

const PATHS: readonly SocialKitPathConfig[] = [
  {
    path: "/linkedin/profile",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/linkedin/company",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/linkedin/company-posts",
    queryNames: ["url", "limit", ...CACHE_QUERY_NAMES],
    maxLimit: 50,
    collection: {
      resultField: "posts",
      defaultLimit: 10,
      pagination: { kind: "none" },
    },
  },
  {
    path: "/linkedin/post",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/linkedin/transcript",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/twitter/profile",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/twitter/tweets",
    queryNames: ["url", "limit", "cursor", ...CACHE_QUERY_NAMES],
    maxLimit: 100,
    collection: {
      resultField: "tweets",
      defaultLimit: 20,
      pagination: { kind: "next_cursor" },
    },
  },
  {
    path: "/twitter/tweet",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/twitter/thread",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/twitter/transcript",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/facebook/stats",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/facebook/channel-stats",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/facebook/transcript",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/facebook/comments",
    queryNames: URL_LIMIT_CURSOR_QUERY_NAMES,
    maxLimit: 100,
    collection: {
      resultField: "comments",
      defaultLimit: 10,
      itemsPerBillingUnit: 50,
      pagination: { kind: "cursor" },
    },
  },
  {
    path: "/facebook/summarize",
    queryNames: SUMMARY_QUERY_NAMES,
  },
  {
    path: "/instagram/stats",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/instagram/channel-stats",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/instagram/transcript",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/instagram/comments",
    queryNames: ["url", "limit", "cursor", "sortBy"],
    maxLimit: 100,
    collection: {
      resultField: "comments",
      defaultLimit: 10,
      itemsPerBillingUnit: 50,
      pagination: { kind: "cursor" },
    },
  },
  {
    path: "/instagram/channel-posts",
    queryNames: URL_LIMIT_CURSOR_QUERY_NAMES,
    maxLimit: 100,
    collection: {
      resultField: "items",
      defaultLimit: 12,
      itemsPerBillingUnit: 20,
      pagination: { kind: "cursor" },
    },
  },
  {
    path: "/instagram/channel-reels",
    queryNames: URL_LIMIT_CURSOR_QUERY_NAMES,
    maxLimit: 100,
    collection: {
      resultField: "items",
      defaultLimit: 12,
      itemsPerBillingUnit: 20,
      pagination: { kind: "cursor" },
    },
  },
  {
    path: "/instagram/reels-search",
    queryNames: ["query", "page"],
    collection: {
      resultField: "items",
      pagination: { kind: "page", maxPage: 2 },
    },
  },
  {
    path: "/instagram/summarize",
    queryNames: SUMMARY_QUERY_NAMES,
  },
  {
    path: "/tiktok/stats",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/tiktok/comments",
    queryNames: URL_LIMIT_CURSOR_QUERY_NAMES,
    maxLimit: 100,
    collection: {
      resultField: "comments",
      defaultLimit: 10,
      itemsPerBillingUnit: 50,
      pagination: { kind: "cursor" },
    },
  },
  {
    path: "/tiktok/transcript",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/tiktok/channel-stats",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/tiktok/channel-videos",
    queryNames: ["url", "limit", "cursor", ...CACHE_QUERY_NAMES],
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 30,
      pagination: { kind: "cursor" },
    },
  },
  {
    path: "/tiktok/search",
    queryNames: [
      "query",
      "limit",
      "cursor",
      "sortBy",
      "datePosted",
      ...CACHE_QUERY_NAMES,
    ],
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 10,
      itemsPerBillingUnit: 50,
      pagination: { kind: "cursor" },
    },
  },
  {
    path: "/tiktok/hashtag-search",
    queryNames: ["hashtag", "limit", "cursor", ...CACHE_QUERY_NAMES],
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 10,
      itemsPerBillingUnit: 50,
      pagination: { kind: "cursor" },
    },
  },
  {
    path: "/tiktok/summarize",
    queryNames: SUMMARY_QUERY_NAMES,
  },
  {
    path: "/youtube/transcript",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/youtube/stats",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/youtube/comments",
    queryNames: ["url", "limit", "sortBy"],
    maxLimit: 100,
    collection: {
      resultField: "comments",
      defaultLimit: 10,
      itemsPerBillingUnit: 50,
      pagination: { kind: "none" },
    },
  },
  {
    path: "/youtube/channel-stats",
    queryNames: URL_CACHE_QUERY_NAMES,
  },
  {
    path: "/youtube/search",
    queryNames: [
      "query",
      "limit",
      "sortBy",
      "uploadDate",
      "type",
      ...CACHE_QUERY_NAMES,
    ],
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 10,
      itemsPerBillingUnit: 50,
      pagination: { kind: "none" },
    },
  },
  {
    path: "/youtube/videos",
    queryNames: ["url", "limit", "full_details", ...CACHE_QUERY_NAMES],
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 10,
      itemsPerBillingUnit: 50,
      pagination: { kind: "none" },
    },
  },
  {
    path: "/youtube/summarize",
    queryNames: SUMMARY_QUERY_NAMES,
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

const queryValueSchema = z.string().min(1).max(SOCIALKIT_MAX_QUERY_VALUE_CHARS);

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

function isBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  const integer = Number(value);
  return (
    Number.isSafeInteger(integer) && integer >= minimum && integer <= maximum
  );
}

function requiredQueryName(
  operation: ManagedSocialKitOperation,
): (typeof REQUIRED_QUERY_NAMES)[number] {
  const name = REQUIRED_QUERY_NAMES.find((candidate) => {
    return operation.queryNames.includes(candidate);
  });
  if (!name) {
    throw new Error(
      `Managed SocialKit operation ${operation.path} has no required query field`,
    );
  }
  return name;
}

interface SocialKitQueryIssue {
  readonly name?: string;
  readonly message: string;
}

function unknownQueryIssue(
  query: Readonly<Record<string, string>> | undefined,
  operation: ManagedSocialKitOperation,
): SocialKitQueryIssue | undefined {
  return query &&
    Object.keys(query).some((name) => {
      return !operation.queryNames.includes(name);
    })
    ? { message: "Query contains a field not reviewed for this operation" }
    : undefined;
}

function missingRequiredQueryIssue(
  query: Readonly<Record<string, string>> | undefined,
  operation: ManagedSocialKitOperation,
): SocialKitQueryIssue | undefined {
  const name = requiredQueryName(operation);
  return query?.[name]?.trim()
    ? undefined
    : { name, message: `${name} is required for this operation` };
}

function boundedIntegerQueryIssue(
  query: Readonly<Record<string, string>> | undefined,
  name: string,
  minimum: number,
  maximum: number,
  message: string,
): SocialKitQueryIssue | undefined {
  const value = query?.[name];
  return value === undefined || isBoundedInteger(value, minimum, maximum)
    ? undefined
    : { name, message };
}

function booleanQueryIssues(
  query: Readonly<Record<string, string>> | undefined,
  operation: ManagedSocialKitOperation,
): SocialKitQueryIssue[] {
  return BOOLEAN_QUERY_NAMES.flatMap((name): SocialKitQueryIssue[] => {
    const value = query?.[name];
    return operation.queryNames.includes(name) &&
      value !== undefined &&
      value !== "true" &&
      value !== "false"
      ? [{ name, message: `${name} must be true or false` }]
      : [];
  });
}

function optionQueryIssues(
  query: Readonly<Record<string, string>> | undefined,
  operation: ManagedSocialKitOperation,
): SocialKitQueryIssue[] {
  return Object.entries(QUERY_VALUE_OPTIONS[operation.path] ?? {}).flatMap(
    ([name, options]): SocialKitQueryIssue[] => {
      const value = query?.[name];
      return value !== undefined && !options.includes(value)
        ? [{ name, message: `${name} must be one of: ${options.join(", ")}` }]
        : [];
    },
  );
}

function hashtagQueryIssue(
  query: Readonly<Record<string, string>> | undefined,
  operation: ManagedSocialKitOperation,
): SocialKitQueryIssue | undefined {
  return operation.queryNames.includes("hashtag") &&
    query?.hashtag?.startsWith("#")
    ? { name: "hashtag", message: "hashtag must not include the # prefix" }
    : undefined;
}

function socialKitQueryIssues(
  query: Readonly<Record<string, string>> | undefined,
  operation: ManagedSocialKitOperation,
): (SocialKitQueryIssue | undefined)[] {
  return [
    unknownQueryIssue(query, operation),
    missingRequiredQueryIssue(query, operation),
    operation.maxLimit === undefined
      ? undefined
      : boundedIntegerQueryIssue(
          query,
          "limit",
          1,
          operation.maxLimit,
          `limit must be an integer from 1 to ${operation.maxLimit} for this operation`,
        ),
    boundedIntegerQueryIssue(
      query,
      "page",
      1,
      2,
      "page must be an integer from 1 to 2 for this operation",
    ),
    boundedIntegerQueryIssue(
      query,
      "cache_ttl",
      CACHE_TTL_MIN_SECONDS,
      CACHE_TTL_MAX_SECONDS,
      `cache_ttl must be an integer from ${CACHE_TTL_MIN_SECONDS} to ${CACHE_TTL_MAX_SECONDS}`,
    ),
    hashtagQueryIssue(query, operation),
    ...booleanQueryIssues(query, operation),
    ...optionQueryIssues(query, operation),
  ];
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
    for (const issue of socialKitQueryIssues(request.query, operation)) {
      if (!issue) {
        continue;
      }
      context.addIssue({
        code: "custom",
        path: issue.name ? ["query", issue.name] : ["query"],
        message: issue.message,
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
  billingQuantity: z.number().int().positive(),
  creditsCharged: z.number().int().nonnegative(),
  collection: z
    .discriminatedUnion("state", [
      z.object({
        state: z.literal("more"),
        itemsReturned: z.number().int().nonnegative(),
        nextQuery: z.record(z.string(), z.string()),
      }),
      z.object({
        state: z.literal("complete"),
        itemsReturned: z.number().int().nonnegative(),
      }),
      z.object({
        state: z.literal("provider_limited"),
        itemsReturned: z.number().int().nonnegative(),
      }),
    ])
    .nullable(),
  result: z.unknown(),
});

export type SocialKitRequest = z.infer<typeof socialKitRequestSchema>;
export type SocialKitResponse = z.infer<typeof socialKitResponseSchema>;

export const socialContract = c.router({
  request: {
    method: "POST",
    path: "/api/social/request",
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
