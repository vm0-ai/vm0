import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be formatted as YYYY-MM-DD");

export const zeroBankingProviderSchema = z.literal("finicity");

export const zeroBankingAccountSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  institutionName: z.string().nullable(),
  type: z.string().nullable(),
  last4: z.string().nullable(),
  status: z.string().nullable(),
  currency: z.string().nullable(),
});

export const zeroBankingBalanceSchema = z.object({
  accountId: z.string(),
  name: z.string().nullable(),
  type: z.string().nullable(),
  balance: z.number().nullable(),
  availableBalance: z.number().nullable(),
  currency: z.string().nullable(),
  balanceDate: z.number().nullable(),
});

export const zeroBankingTransactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  amount: z.number().nullable(),
  description: z.string().nullable(),
  memo: z.string().nullable(),
  postedDate: z.number().nullable(),
  transactionDate: z.number().nullable(),
  status: z.string().nullable(),
  categorization: z.string().nullable(),
  merchant: z.string().nullable(),
});

export const zeroBankingAccountsResponseSchema = z.object({
  operation: z.literal("accounts"),
  provider: zeroBankingProviderSchema,
  accounts: z.array(zeroBankingAccountSchema),
});

export const zeroBankingBalancesRequestSchema = z.object({
  accountId: z.string().trim().min(1),
});

export const zeroBankingBalancesResponseSchema = z.object({
  operation: z.literal("balances"),
  provider: zeroBankingProviderSchema,
  balance: zeroBankingBalanceSchema,
});

export const zeroBankingTransactionsRequestSchema = z.object({
  accountId: z.string().trim().min(1),
  from: dateOnlySchema,
  to: dateOnlySchema,
  limit: z.number().int().min(1).max(1000).default(100),
});

export const zeroBankingTransactionsResponseSchema = z.object({
  operation: z.literal("transactions"),
  provider: zeroBankingProviderSchema,
  accountId: z.string(),
  transactions: z.array(zeroBankingTransactionSchema),
});

const zeroBankingAccountsResponses = {
  200: zeroBankingAccountsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

const zeroBankingBalancesResponses = {
  200: zeroBankingBalancesResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

const zeroBankingTransactionsResponses = {
  200: zeroBankingTransactionsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const zeroBankingContract = c.router({
  accounts: {
    method: "POST",
    path: "/api/zero/banking/accounts",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: zeroBankingAccountsResponses,
    summary: "List accounts through the managed Zero Banking gateway",
  },
  balances: {
    method: "POST",
    path: "/api/zero/banking/balances",
    headers: authHeadersSchema,
    body: zeroBankingBalancesRequestSchema,
    responses: zeroBankingBalancesResponses,
    summary: "Read an account balance through the managed Zero Banking gateway",
  },
  transactions: {
    method: "POST",
    path: "/api/zero/banking/transactions",
    headers: authHeadersSchema,
    body: zeroBankingTransactionsRequestSchema,
    responses: zeroBankingTransactionsResponses,
    summary:
      "Read account transactions through the managed Zero Banking gateway",
  },
});

export type ZeroBankingContract = typeof zeroBankingContract;
export type ZeroBankingAccount = z.infer<typeof zeroBankingAccountSchema>;
export type ZeroBankingBalance = z.infer<typeof zeroBankingBalanceSchema>;
export type ZeroBankingTransaction = z.infer<
  typeof zeroBankingTransactionSchema
>;
export type ZeroBankingAccountsResponse = z.infer<
  typeof zeroBankingAccountsResponseSchema
>;
export type ZeroBankingBalancesRequest = z.infer<
  typeof zeroBankingBalancesRequestSchema
>;
export type ZeroBankingBalancesResponse = z.infer<
  typeof zeroBankingBalancesResponseSchema
>;
export type ZeroBankingTransactionsRequest = z.infer<
  typeof zeroBankingTransactionsRequestSchema
>;
export type ZeroBankingTransactionsResponse = z.infer<
  typeof zeroBankingTransactionsResponseSchema
>;
