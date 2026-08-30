import { command, computed, state } from "ccstate";
import emojiGroups from "../../data/chat-thread-emoji.json";

export interface ChatThreadEmojiItem {
  emoji: string;
  name: string;
}

interface ChatThreadEmojiGroup {
  name: string;
  emojis: ChatThreadEmojiItem[];
}

export const chatThreadEmojiGroups$ = computed((): ChatThreadEmojiGroup[] => {
  return emojiGroups;
});

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

// The emoji the pointer or keyboard is currently on, named in the preview bar
// under the grid. Held in a signal so pointing at a new emoji re-renders that
// bar alone rather than the whole grid it sits under.
const internalChatThreadEmojiPreview$ = state<ChatThreadEmojiItem | null>(null);

export const chatThreadEmojiPreview$ = computed((get) => {
  return get(internalChatThreadEmojiPreview$);
});

export const setChatThreadEmojiPreview$ = command(
  ({ get, set }, value: ChatThreadEmojiItem | null) => {
    // Pointing at one emoji fires repeatedly as the pointer moves across it.
    if (get(internalChatThreadEmojiPreview$)?.emoji === value?.emoji) {
      return;
    }
    set(internalChatThreadEmojiPreview$, value);
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
