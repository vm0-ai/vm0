declare module "unicode-emoji-json/data-by-group.json" {
  interface UnicodeEmojiEntry {
    emoji: string;
    name: string;
    slug: string;
    skin_tone_support: boolean;
    unicode_version: string;
    emoji_version: string;
  }
  interface UnicodeEmojiGroup {
    name: string;
    slug: string;
    emojis: UnicodeEmojiEntry[];
  }
  const groups: UnicodeEmojiGroup[];
  export default groups;
}
