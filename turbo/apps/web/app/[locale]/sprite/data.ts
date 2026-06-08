export interface SpriteItem {
  readonly slug: string;
  readonly title: string;
  readonly prompt: string;
  readonly embedUrl: string;
  readonly previewImage: string;
  readonly previewWidth: number;
  readonly previewHeight: number;
}

export const SPRITE_ITEMS: readonly SpriteItem[] = [
  {
    slug: "earth-titan-idle",
    title: "Earth titan idle",
    prompt:
      "/gen sprite Create a huge ancient earth titan idle animation. It should feel heavy, slow, and powerful, with subtle breathing, shifting stone plates, and glowing runes. Make it a clean 3x3 sprite sheet with transparent frames and a GIF preview. Put the raw sheet, transparent sheet, frames, and GIF on a simple showcase page, then upload to website.",
    embedUrl: "https://gen-sprite-earth-titan-idle-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/08451aba-756b-4f24-9d35-d4f71a3f8ce7/earth-titan-idle.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "ember-knight-hero",
    title: "Ember knight hero",
    prompt:
      "/gen sprite Create a side-view playable ember knight with idle, run, jump, and sword attack animations. Keep the character scale consistent across all actions, and put the sword slash and hit spark into separate FX assets so the body animation stays usable in a game. Show every exported sheet and GIF on a showcase page, then upload to website.",
    embedUrl: "https://gen-sprite-ember-knight-hero-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e9ced0dc-4471-4125-be60-91611ab21a30/ember-knight-hero.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "moon-mage-spell",
    title: "Moon mage spell",
    prompt:
      "/gen sprite Create a complete moon mage spell bundle: the caster charging the spell, a crescent moon projectile, and a shimmering impact burst. The three assets should share the same color palette and feel like one coherent ability. Export transparent sheets, frames, and GIF previews, then build a small spell showcase page and upload to website.",
    embedUrl: "https://gen-sprite-moon-mage-spell-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/20ac43ca-aff4-4878-9fc2-c0800b2eb9cf/moon-mage-spell.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "forest-scout-walk",
    title: "Forest scout walk",
    prompt:
      "/gen sprite Create a top-down 16-bit forest scout player walk sheet with four directions: down, left, right, and up. The outfit, scale, and feet position should stay stable in every frame. Export the transparent sheet, individual frames, direction strips, and GIF previews, then create an engine handoff showcase page and upload to website.",
    embedUrl: "https://gen-sprite-forest-scout-walk-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2d2510d2-352d-4c94-bc69-16b311067c1a/forest-scout-walk.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "village-healer-npc",
    title: "Village healer NPC",
    prompt:
      "/gen sprite Create a friendly village healer NPC for a top-down RPG. Include a calm idle, a short walking loop, and a small hurt reaction. Keep the robe, staff, satchel, and colors consistent across the animations. Export the transparent assets and GIFs, then make a character preview page and upload to website.",
    embedUrl: "https://gen-sprite-village-healer-npc-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6e5a4126-1273-401d-84c2-fc5e264f61f2/village-healer-npc.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "plasma-bolt-fx",
    title: "Plasma bolt FX",
    prompt:
      "/gen sprite Create a clean plasma bolt projectile and a matching impact burst. The projectile should loop well, and the impact should read clearly as a hit effect. Keep both effects contained inside their frames and export transparent sheets, individual frames, and GIFs. Present them together on a compact FX showcase page, then upload to website.",
    embedUrl: "https://gen-sprite-plasma-bolt-fx-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d1df47cb-7819-4888-ac4a-ce8e07822858/plasma-bolt-fx.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "forest-shrine-props",
    title: "Forest shrine props",
    prompt:
      "/gen sprite Create a clean hand-painted prop pack for a forest shrine map. Include nine compact reusable props like mossy stones, small lanterns, a signpost, a ritual bowl, flowers, a fallen branch, a shrine charm, a stump, and a crate. Export each prop as a transparent PNG and show the full pack on a gallery page, then upload to website.",
    embedUrl: "https://gen-sprite-forest-shrine-props-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2ceb6040-db0a-440b-a7b4-b9d5342d3e75/forest-shrine-props.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "crystal-wolf-summon",
    title: "Crystal wolf summon",
    prompt:
      "/gen sprite Create a crystal wolf summon entrance animation. It should start with a magic circle, build the wolf from floating crystal shards, and end with the wolf fully formed in a ready stance. Export the transparent sheet, frames, and GIF preview, then create a frame-by-frame showcase page and upload to website.",
    embedUrl: "https://gen-sprite-crystal-wolf-summon-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e460497c-0697-42d0-89ee-eeb563ebc73e/crystal-wolf-summon.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "fire-samurai-line",
    title: "Fire samurai line",
    prompt:
      "/gen sprite Create a three-form fire samurai creature evolution line. The first form should feel like an ember novice, the second like a flame warrior, and the final form like an inferno commander. Each form should have an idle animation, and all three should share clear lineage markers. Make a comparison showcase page with the GIFs and sheets, then upload to website.",
    embedUrl: "https://gen-sprite-fire-samurai-line-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fa1ff729-56e4-4817-841e-0a520c925203/fire-samurai-line.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
  {
    slug: "clockwork-rogue-atlas",
    title: "Clockwork rogue atlas",
    prompt:
      "/gen sprite Create a side-view clockwork rogue character for a game engine. Include idle, run, attack, hurt, and death animations. Keep the body scale stable, and separate sparks, gears, and weapon trails into FX assets if they would make the main body too small. Export all transparent sheets, frames, GIFs, and an engine-ready atlas preview, then upload to website.",
    embedUrl: "https://gen-sprite-clockwork-rogue-atlas-715f6d07.sites.vm0.io",
    previewImage:
      "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c00da247-c75c-4419-a5c7-d09da5f9e8db/clockwork-rogue-atlas.png",
    previewWidth: 1280,
    previewHeight: 900,
  },
];

export function buildSpriteRemixHref(item: SpriteItem, appUrl: string): string {
  const url = new URL("/onboarding", appUrl);
  url.searchParams.set("prompt", item.prompt);
  url.searchParams.set("showcase", item.embedUrl);
  return url.toString();
}
