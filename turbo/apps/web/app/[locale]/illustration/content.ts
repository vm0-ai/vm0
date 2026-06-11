// Marketing copy for the /illustration funnel page. Kept as plain data so the
// gallery client stays focused on rendering. The arc mirrors a product landing
// page: value prop → capabilities → comparison → results gallery → audiences →
// FAQ → final CTA.

export const SIGNUP_HREF = "/sign-up";

interface IllustrationFeature {
  readonly title: string;
  readonly body: string;
}

export const ILLUSTRATION_FEATURES: readonly IllustrationFeature[] = [
  {
    title: "30+ locked house styles",
    body: "Pick from a register of editorial styles — Loose Contour, Riso Relic, Folk Storybook, Jade Blockprint and more. Each is a fixed recipe, not a vibe you re-describe every time.",
  },
  {
    title: "Consistent across a series",
    body: "Palette, line weight, and cast are dials Zero holds steady. Generate a ten-piece blog set or a campaign and every frame belongs to the same family.",
  },
  {
    title: "Brief-aware, not prompt roulette",
    body: "Zero reads your topic, picks the metaphor and scene, and composes the piece. You describe the idea; it handles the art direction.",
  },
  {
    title: "Invoke as a skill, regenerate on demand",
    body: "Each style is a Zero skill. Call it, tweak the brief, and re-run for a fresh variation — no re-prompting from scratch.",
  },
];

interface ComparisonRow {
  readonly aspect: string;
  readonly generic: string;
  readonly zero: string;
}

export const ILLUSTRATION_COMPARISON: readonly ComparisonRow[] = [
  {
    aspect: "Style consistency",
    generic: "Drifts with every prompt",
    zero: "Locked recipe, repeatable",
  },
  {
    aspect: "Across a series",
    generic: "Each image is its own world",
    zero: "Shared palette, line & cast",
  },
  {
    aspect: "Art direction",
    generic: "You write the whole prompt",
    zero: "Zero researches & composes from a brief",
  },
  {
    aspect: "Revisions",
    generic: "Re-prompt and hope",
    zero: "Re-run the skill, same style",
  },
  {
    aspect: "What you keep",
    generic: "A one-off file",
    zero: "A reusable, named style skill",
  },
];

interface AudienceCard {
  readonly title: string;
  readonly body: string;
}

export const ILLUSTRATION_AUDIENCES: readonly AudienceCard[] = [
  {
    title: "Founders & solo builders",
    body: "Give your blog and brand a consistent visual voice without hiring an illustrator for every post.",
  },
  {
    title: "Marketing & content teams",
    body: "Spin up campaign and social visuals that all look like one brand — fast enough to keep up with the calendar.",
  },
  {
    title: "Designers",
    body: "Get on-brand drafts and explorations in seconds, then take them the last mile yourself.",
  },
];

interface FaqItem {
  readonly q: string;
  readonly a: string;
}

export const ILLUSTRATION_FAQ: readonly FaqItem[] = [
  {
    q: "How is this different from a normal AI image generator?",
    a: "A normal generator gives you a different look every prompt. Here you pick a fixed style from the register and Zero reproduces it consistently — across one image or a whole series — driven by a brief instead of a long prompt.",
  },
  {
    q: "Can I use the illustrations commercially?",
    a: "Yes. Illustrations you generate are yours to use in products, marketing, and content.",
  },
  {
    q: "How does the consistency actually work?",
    a: "Each style is a locked recipe in the vm0-skills register — palette, line, grain, and cast are fixed reference points. Zero varies the scene and subject per brief while holding the look steady.",
  },
  {
    q: "Can I add my own style?",
    a: "Yes. Styles are open skills in the vm0-skills repo. A new house style can be trained from your references and registered alongside these.",
  },
  {
    q: "What formats do I get?",
    a: "Standard raster output sized for editorial and social use; several styles support transparent PNGs for stickers and overlays.",
  },
  {
    q: "How do I generate one?",
    a: "Sign in to Zero, invoke the style you want as a skill, and describe the piece. Zero researches, composes, and returns the illustration — re-run anytime for variations.",
  },
];
