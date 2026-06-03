import { command, computed, state } from "ccstate";
import {
  zeroMemoryContract,
  type MemoryDetailResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  zeroMemoryActivityContract,
  type MemoryActivityResponse,
} from "@vm0/api-contracts/contracts/zero-memory-activity";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

export type MemoryTab = "updates" | "raw";

const internalSelectedMemoryFilePath$ = state<string | null>(null);

export const selectedMemoryFilePath$ = computed((get) => {
  return get(internalSelectedMemoryFilePath$);
});

export const setSelectedMemoryFilePath$ = command(
  ({ set }, filePath: string | null) => {
    set(internalSelectedMemoryFilePath$, filePath);
  },
);

const internalMemoryTab$ = state<MemoryTab>("updates");

export const memoryTab$ = computed((get) => {
  return get(internalMemoryTab$);
});

export const setMemoryTab$ = command(({ set }, tab: MemoryTab) => {
  set(internalMemoryTab$, tab);
});

// Per-item expand state for the Updates timeline, keyed by a stable item key.
// Mirrors the keyed-record ephemeral UI state pattern used elsewhere in the
// platform (e.g. view-component-state) since `useState` is restricted here.
const internalExpandedMemoryItems$ = state<Record<string, boolean>>({});

export const expandedMemoryItems$ = computed((get) => {
  return get(internalExpandedMemoryItems$);
});

export const toggleMemoryItemExpanded$ = command(({ set }, key: string) => {
  set(internalExpandedMemoryItems$, (current) => {
    return { ...current, [key]: !current[key] };
  });
});

export const memoryDetail$ = computed(
  async (get): Promise<MemoryDetailResponse> => {
    const client = get(zeroClient$)(zeroMemoryContract);
    const result = await accept(client.get(), [200], { toast: false });
    return result.body;
  },
);

export const memoryActivity$ = computed(
  async (get): Promise<MemoryActivityResponse> => {
    const client = get(zeroClient$)(zeroMemoryActivityContract);
    const result = await accept(client.get(), [200], { toast: false });
    return result.body;
  },
);
