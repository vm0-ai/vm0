/** Stored as lowercase in metadata.sound. */
export const TONE_OPTIONS = [
  "professional",
  "friendly",
  "direct",
  "supportive",
] as const;

export type Tone = (typeof TONE_OPTIONS)[number];
