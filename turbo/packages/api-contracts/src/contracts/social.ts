import { z } from "zod";

import {
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIALKIT_TOOLS,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolName,
  socialKitRequestSchema,
} from "./social-tools";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export {
  findManagedSocialKitTool,
  managedSocialKitToolCatalog,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIALKIT_TOOLS,
  SOCIALKIT_MAX_INPUT_VALUE_CHARS,
  socialKitRequestSchema,
  type ManagedSocialKitCollection,
  type ManagedSocialKitPagination,
  type ManagedSocialKitResultField,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolDefinition,
  type ManagedSocialKitToolCatalogEntry,
  type ManagedSocialKitToolName,
  type SocialKitRequest,
} from "./social-tools";

const c = initContract();

const socialKitCollectionSchema = z
  .discriminatedUnion("state", [
    z.object({
      state: z.literal("more"),
      itemsReturned: z.number().int().nonnegative(),
      nextInput: z.union([
        z.object({ cursor: z.string().min(1) }).strict(),
        z.object({ page: z.number().int().positive() }).strict(),
      ]),
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
  .nullable();

type ToolByName<Name extends ManagedSocialKitToolName> = Extract<
  ManagedSocialKitTool,
  { readonly name: Name }
>;

export type SocialKitInput<Name extends ManagedSocialKitToolName> = z.infer<
  ToolByName<Name>["inputSchema"]
>;

export type SocialKitResult<Name extends ManagedSocialKitToolName> = z.infer<
  ToolByName<Name>["resultSchema"]
>;

type SocialKitResponseFor<Tool extends ManagedSocialKitTool> =
  Tool extends ManagedSocialKitTool
    ? {
        readonly provider: "socialkit";
        readonly tool: Tool["name"];
        readonly billingCategory: typeof MANAGED_SOCIALKIT_BILLING_CATEGORY;
        readonly billingQuantity: number;
        readonly creditsCharged: number;
        readonly collection: z.infer<typeof socialKitCollectionSchema>;
        readonly result: z.infer<Tool["resultSchema"]>;
      }
    : never;

export type SocialKitResponse = SocialKitResponseFor<ManagedSocialKitTool>;

function responseVariant<Tool extends ManagedSocialKitTool>(tool: Tool) {
  return z.object({
    provider: z.literal("socialkit"),
    tool: z.literal(tool.name),
    billingCategory: z.literal(MANAGED_SOCIALKIT_BILLING_CATEGORY),
    billingQuantity: z.number().int().positive(),
    creditsCharged: z.number().int().nonnegative(),
    collection: socialKitCollectionSchema,
    result: tool.resultSchema,
  });
}

type SocialKitResponseSchemaFor<Tool extends ManagedSocialKitTool> = z.ZodType<
  SocialKitResponseFor<Tool>
>;

type SocialKitResponseSchemas<Tools extends readonly ManagedSocialKitTool[]> = {
  readonly [Index in keyof Tools]: SocialKitResponseSchemaFor<Tools[Index]>;
};

function responseSchemas<
  const Tools extends readonly [
    ManagedSocialKitTool,
    ManagedSocialKitTool,
    ...ManagedSocialKitTool[],
  ],
>(tools: Tools): SocialKitResponseSchemas<Tools> {
  // Array.map cannot retain a const tuple's per-index generic relationship.
  return tools.map(responseVariant) as SocialKitResponseSchemas<Tools>;
}

export const socialKitResponseSchema = z.union(
  responseSchemas(MANAGED_SOCIALKIT_TOOLS),
);

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
    summary: "Call a typed managed SocialKit tool",
  },
});

export type SocialContract = typeof socialContract;
