import { command, computed, state } from "ccstate";

export interface ChatThreadEmojiItem {
  emoji: string;
  name: string;
}

interface ChatThreadEmojiGroup {
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

// Which category the rail highlights. Normally it follows the feed, so it names
// whichever section title is currently pinned to the top.
const internalChatThreadEmojiActiveCategory$ = state<string | null>(null);

export const chatThreadEmojiActiveCategory$ = computed((get) => {
  return get(internalChatThreadEmojiActiveCategory$);
});

// The feed reports the pinned category on every scroll event, so ignore the
// repeats: without this the rail would re-render the whole emoji grid at scroll
// frequency instead of only when the category actually changes.
export const setChatThreadEmojiActiveCategory$ = command(
  ({ get, set }, value: string | null) => {
    if (get(internalChatThreadEmojiActiveCategory$) === value) {
      return;
    }
    set(internalChatThreadEmojiActiveCategory$, value);
  },
);

// A click-to-jump smooth scroll travels over every category in between, which
// would flicker the rail through all of them. Hold the requested category here
// so the feed stops driving the highlight until it lands.
const internalChatThreadEmojiPendingJump$ = state<string | null>(null);

export const chatThreadEmojiPendingJump$ = computed((get) => {
  return get(internalChatThreadEmojiPendingJump$);
});

export const setChatThreadEmojiPendingJump$ = command(
  ({ set }, value: string | null) => {
    set(internalChatThreadEmojiPendingJump$, value);
  },
);

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
