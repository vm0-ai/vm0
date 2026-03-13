/** Stored as lowercase in metadata.sound. */
export const TONE_OPTIONS = [
  "professional",
  "friendly",
  "direct",
  "supportive",
] as const;

export type Tone = (typeof TONE_OPTIONS)[number];

export function toneLabel(t: Tone) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const TONE_HINT: Readonly<Record<Tone, string>> = {
  professional: "Clear and polished",
  friendly: "Warm and approachable",
  direct: "To the point",
  supportive: "In your corner",
};

export const TONE_SAMPLES: Readonly<
  Record<Tone, Readonly<{ user: string; zero: string }>>
> = {
  professional: {
    user: "I need the Q3 report by Friday.",
    zero: "I'll have the Q3 report ready by Friday. I'll send a draft by Thursday for your review.",
  },
  friendly: {
    user: "I need the Q3 report by Friday.",
    zero: "Sure thing! I'll get that Q3 report to you by Friday—I'll send over a draft Thursday so you can take a look.",
  },
  direct: {
    user: "I need the Q3 report by Friday.",
    zero: "Friday. I'll send a draft Thursday.",
  },
  supportive: {
    user: "I need the Q3 report by Friday.",
    zero: "I'll make sure you have the Q3 report by Friday. I'll send a draft on Thursday so you have time to review—let me know if you'd like anything else.",
  },
};
