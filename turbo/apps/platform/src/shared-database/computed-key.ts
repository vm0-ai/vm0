import { DESKTOP_PRODUCTS } from "@okouai/api-contracts/contracts/client-headers";
import { computerUseHostStatusSchema } from "@okouai/api-contracts/contracts/computer-use";
import { z } from "zod";

import {
  chatThreadIndicatorsSchema,
  type ChatThreadIndicators,
} from "./data-key.ts";

export const computedKeySchema = z.enum([
  "chat-thread-indicators",
  "computer-use-hosts",
]);

export type ComputedKey = z.infer<typeof computedKeySchema>;

export const listedComputerUseHostSchema = z
  .object({
    id: z.string(),
    product: z.enum(DESKTOP_PRODUCTS),
    hostName: z.string(),
    displayName: z.string(),
    lastSeenAt: z.string(),
    status: computerUseHostStatusSchema,
  })
  .strict();

export type ListedComputerUseHost = z.infer<typeof listedComputerUseHostSchema>;

interface ComputedValueMap {
  readonly "chat-thread-indicators": ChatThreadIndicators;
  readonly "computer-use-hosts": ListedComputerUseHost[];
}

export type ComputedValue<TKey extends ComputedKey> = ComputedValueMap[TKey];

export function parseComputedValue<TKey extends ComputedKey>(
  computedKey: TKey,
  value: unknown,
): ComputedValue<TKey>;
export function parseComputedValue(
  computedKey: ComputedKey,
  value: unknown,
): ComputedValue<ComputedKey> {
  if (computedKey === "chat-thread-indicators") {
    return chatThreadIndicatorsSchema.parse(value);
  }
  return listedComputerUseHostSchema.array().parse(value);
}
