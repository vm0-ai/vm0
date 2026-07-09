import type {
  MemoryContextResponse,
  MemoryRecallItem,
  MemoryRecallItemKind,
  MemoryRecallResponse,
} from "@vm0/api-contracts/contracts/zero-memory";

import type { ReadonlyDb } from "../external/db";
import {
  getZeroMemoryProfile,
  toMemoryRecallItem,
} from "./zero-memory-profile.service";

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface RecallParams extends MemoryScope {
  readonly q: string;
  readonly kind?: MemoryRecallItemKind;
  readonly limit: number;
}

interface ContextParams extends MemoryScope {
  readonly q?: string;
  readonly limit: number;
}

const RECALL_MEMORY_KINDS = ["key_fact", "preference", "open_loop"] as const;

async function loadMemoryItems(
  db: ReadonlyDb,
  params: RecallParams | ContextParams,
): Promise<readonly MemoryRecallItem[]> {
  const searchKinds =
    "kind" in params && params.kind ? [params.kind] : RECALL_MEMORY_KINDS;
  const profile = await getZeroMemoryProfile(db, {
    orgId: params.orgId,
    userId: params.userId,
    query: params.q,
    staticKinds: [],
    dynamicKinds: [],
    searchKinds,
    staticLimit: 0,
    dynamicLimit: 0,
    searchLimit: params.limit,
    includeGraphExpansion: true,
    entityTypes: ["person", "organization"],
  });
  return profile.searchResults
    .map(toMemoryRecallItem)
    .filter((item): item is MemoryRecallItem => {
      return item !== null;
    });
}

export async function recallZeroMemory(
  db: ReadonlyDb,
  params: RecallParams,
): Promise<MemoryRecallResponse> {
  const memories = await loadMemoryItems(db, params);
  return { query: params.q, memories: [...memories] };
}

function kindLabel(kind: MemoryRecallItemKind): string {
  switch (kind) {
    case "preference": {
      return "Preferences";
    }
    case "open_loop": {
      return "Open loops";
    }
    case "key_fact": {
      return "Key facts";
    }
  }
}

function sourceRef(memory: MemoryRecallItem): string {
  const source = memory.sources[0];
  if (!source) {
    return "";
  }
  return ` [${source.provider}:${source.externalId}]`;
}

function formatMemoryContext(memories: readonly MemoryRecallItem[]): string {
  if (memories.length === 0) {
    return "";
  }

  const lines = ["Structured memory:"];
  for (const kind of ["preference", "open_loop", "key_fact"] as const) {
    const matching = memories.filter((memory) => {
      return memory.kind === kind;
    });
    if (matching.length === 0) {
      continue;
    }
    lines.push("", `${kindLabel(kind)}:`);
    for (const memory of matching) {
      const entity = memory.relationship.entity.displayName;
      lines.push(`- ${memory.text} (${entity})${sourceRef(memory)}`);
    }
  }
  return lines.join("\n");
}

export async function getZeroMemoryContext(
  db: ReadonlyDb,
  params: ContextParams,
): Promise<MemoryContextResponse> {
  const memories = await loadMemoryItems(db, params);
  return {
    query: params.q ?? null,
    context: formatMemoryContext(memories),
    memories: [...memories],
  };
}
