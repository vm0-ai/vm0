import { command, computed, state } from "ccstate";
import {
  zeroMemoryContract,
  type MemoryDetailResponse,
} from "@vm0/api-contracts/contracts/zero-memory";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

const internalSelectedMemoryFilePath$ = state<string | null>(null);

export const selectedMemoryFilePath$ = computed((get) => {
  return get(internalSelectedMemoryFilePath$);
});

export const setSelectedMemoryFilePath$ = command(
  ({ set }, filePath: string | null) => {
    set(internalSelectedMemoryFilePath$, filePath);
  },
);

export const memoryDetail$ = computed(
  async (get): Promise<MemoryDetailResponse> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(client.get(), [200], { toast: false });
    return result.body;
  },
);
