import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be formatted as YYYY-MM-DD");

export const bankingProviderSchema = z.literal("finicity");

export const bankingAccountSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  institutionName: z.string().nullable(),
  type: z.string().nullable(),
  last4: z.string().nullable(),
  status: z.string().nullable(),
  currency: z.string().nullable(),
});

export const bankingBalanceSchema = z.object({
  accountId: z.string(),
  name: z.string().nullable(),
  type: z.string().nullable(),
  balance: z.number().nullable(),
  availableBalance: z.number().nullable(),
  currency: z.string().nullable(),
  balanceDate: z.number().nullable(),
});

export const bankingTransactionSchema = z.object({
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

export const bankingAccountsResponseSchema = z.object({
  operation: z.literal("accounts"),
  provider: bankingProviderSchema,
  accounts: z.array(bankingAccountSchema),
});

export const bankingBalancesRequestSchema = z.object({
  accountId: z.string().trim().min(1),
});

export const bankingBalancesResponseSchema = z.object({
  operation: z.literal("balances"),
  provider: bankingProviderSchema,
  balance: bankingBalanceSchema,
});

export const bankingTransactionsRequestSchema = z.object({
  accountId: z.string().trim().min(1),
  from: dateOnlySchema,
  to: dateOnlySchema,
  limit: z.number().int().min(1).max(1000).default(100),
});

export const bankingTransactionsResponseSchema = z.object({
  operation: z.literal("transactions"),
  provider: bankingProviderSchema,
  accountId: z.string(),
  transactions: z.array(bankingTransactionSchema),
});

const bankingAccountsResponses = {
  200: bankingAccountsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

const bankingBalancesResponses = {
  200: bankingBalancesResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

const bankingTransactionsResponses = {
  200: bankingTransactionsResponseSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const bankingContract = c.router({
  accounts: {
    method: "POST",
    path: "/api/banking/accounts",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: bankingAccountsResponses,
    summary: "List accounts through the managed Zero Banking gateway",
  },
  balances: {
    method: "POST",
    path: "/api/banking/balances",
    headers: authHeadersSchema,
    body: bankingBalancesRequestSchema,
    responses: bankingBalancesResponses,
    summary: "Read an account balance through the managed Zero Banking gateway",
  },
  transactions: {
    method: "POST",
    path: "/api/banking/transactions",
    headers: authHeadersSchema,
    body: bankingTransactionsRequestSchema,
    responses: bankingTransactionsResponses,
    summary:
      "Read account transactions through the managed Zero Banking gateway",
  },
});

export type BankingContract = typeof bankingContract;
export type BankingAccount = z.infer<typeof bankingAccountSchema>;
export type BankingBalance = z.infer<typeof bankingBalanceSchema>;
export type BankingTransaction = z.infer<typeof bankingTransactionSchema>;
export type BankingAccountsResponse = z.infer<
  typeof bankingAccountsResponseSchema
>;
export type BankingBalancesRequest = z.infer<
  typeof bankingBalancesRequestSchema
>;
export type BankingBalancesResponse = z.infer<
  typeof bankingBalancesResponseSchema
>;
export type BankingTransactionsRequest = z.infer<
  typeof bankingTransactionsRequestSchema
>;
export type BankingTransactionsResponse = z.infer<
  typeof bankingTransactionsResponseSchema
>;
