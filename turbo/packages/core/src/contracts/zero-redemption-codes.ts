import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const MAX_CREDITS_PER_CODE = 1_000_000;
export const MAX_QUANTITY_PER_MINT = 100;

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

const mintRequestSchema = z.object({
  creditsPerCode: z.number().int().min(1).max(MAX_CREDITS_PER_CODE),
  quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_MINT),
});

const mintResponseSchema = z.object({
  codes: z.array(
    z.object({
      code: z.string(),
      creditsPerCode: z.number(),
      expiresAt: z.string(),
    }),
  ),
});

export type MintRedemptionCodesRequest = z.infer<typeof mintRequestSchema>;
export type MintRedemptionCodesResponse = z.infer<typeof mintResponseSchema>;

export const zeroRedemptionCodesMintContract = c.router({
  mint: {
    method: "POST",
    path: "/api/zero/redemption-codes",
    headers: authHeadersSchema,
    body: mintRequestSchema,
    responses: {
      200: mintResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Mint new redemption codes (staff-only)",
  },
});

export type ZeroRedemptionCodesMintContract =
  typeof zeroRedemptionCodesMintContract;

// ---------------------------------------------------------------------------
// List (staff-only trace of minted codes + redemption status)
// ---------------------------------------------------------------------------

const listResponseSchema = z.object({
  codes: z.array(
    z.object({
      code: z.string(),
      creditsPerCode: z.number(),
      createdAt: z.string(),
      createdByUserId: z.string(),
      expiresAt: z.string(),
      redeemedAt: z.string().nullable(),
      redeemedByUserId: z.string().nullable(),
      redeemedByOrgId: z.string().nullable(),
    }),
  ),
});

export type ListRedemptionCodesResponse = z.infer<typeof listResponseSchema>;

export const zeroRedemptionCodesListContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/redemption-codes",
    headers: authHeadersSchema,
    responses: {
      200: listResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List minted redemption codes with redemption status (staff-only)",
  },
});

export type ZeroRedemptionCodesListContract =
  typeof zeroRedemptionCodesListContract;

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

const redeemRequestSchema = z.object({
  code: z.string().min(1).max(32),
});

const redeemResponseSchema = z.object({
  credits: z.number(),
  newBalance: z.number(),
});

export type RedeemRedemptionCodeRequest = z.infer<typeof redeemRequestSchema>;
export type RedeemRedemptionCodeResponse = z.infer<typeof redeemResponseSchema>;

export const zeroRedemptionCodesRedeemContract = c.router({
  redeem: {
    method: "POST",
    path: "/api/zero/redemption-codes/redeem",
    headers: authHeadersSchema,
    body: redeemRequestSchema,
    responses: {
      200: redeemResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      429: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Redeem a code for credits",
  },
});

export type ZeroRedemptionCodesRedeemContract =
  typeof zeroRedemptionCodesRedeemContract;
