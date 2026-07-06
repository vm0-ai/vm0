import { command, computed, state } from "ccstate";

export interface ChatThreadEmojiItem {
  emoji: string;
  name: string;
}

export interface ChatThreadEmojiGroup {
  name: string;
  emojis: ChatThreadEmojiItem[];
}

// The full emoji dataset (~1,900 entries) is only needed once the user opens
// the picker, so it is loaded on demand and kept out of the main bundle.
export const chatThreadEmojiGroups$ = computed(
  async (): Promise<ChatThreadEmojiGroup[]> => {
    const module = await import("unicode-emoji-json/data-by-group.json");
    return module.default.map((group) => {
      return {
        name: group.name,
        emojis: group.emojis.map((entry) => {
          return { emoji: entry.emoji, name: entry.name };
        }),
      };
    });
  },
);

const internalChatThreadEmojiQuery$ = state("");

export const chatThreadEmojiQuery$ = computed((get) => {
  return get(internalChatThreadEmojiQuery$);
});

export const setChatThreadEmojiQuery$ = command(({ set }, value: string) => {
  set(internalChatThreadEmojiQuery$, value);
});

export function filterChatThreadEmojiGroups(
  groups: ChatThreadEmojiGroup[],
  query: string,
): ChatThreadEmojiItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const matches: ChatThreadEmojiItem[] = [];
  for (const group of groups) {
    for (const item of group.emojis) {
      if (item.name.includes(normalized)) {
        matches.push(item);
      }
    }
  }
  return matches;
}
