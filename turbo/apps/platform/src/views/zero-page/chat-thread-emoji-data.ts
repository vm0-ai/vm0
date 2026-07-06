export interface ChatThreadEmojiItem {
  emoji: string;
  name: string;
}

export interface ChatThreadEmojiGroup {
  name: string;
  emojis: ChatThreadEmojiItem[];
}

let cachedGroups: ChatThreadEmojiGroup[] | null = null;
let pendingGroups: Promise<ChatThreadEmojiGroup[]> | null = null;

// The full emoji dataset (~1,900 entries) is only needed once the user opens
// the picker, so it is loaded on demand and kept out of the main bundle.
export async function loadChatThreadEmojiGroups(): Promise<
  ChatThreadEmojiGroup[]
> {
  if (cachedGroups) {
    return cachedGroups;
  }
  if (!pendingGroups) {
    pendingGroups = import("unicode-emoji-json/data-by-group.json").then(
      (module) => {
        const groups = module.default.map((group) => ({
          name: group.name,
          emojis: group.emojis.map((entry) => ({
            emoji: entry.emoji,
            name: entry.name,
          })),
        }));
        cachedGroups = groups;
        return groups;
      },
    );
  }
  return pendingGroups;
}

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
