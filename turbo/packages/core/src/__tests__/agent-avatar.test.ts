import { describe, expect, it } from "vitest";

import {
  AVATAR_COMPOSER_EXPRESSIONS,
  AVATAR_COMPOSER_FACE_SHAPES,
  AVATAR_COMPOSER_HAIR_COLORS,
  AVATAR_COMPOSER_HAIR_STYLES,
  AVATAR_COMPOSER_SKIN_TONES,
  avatarComposerUrl,
  isAvatarComposerCombinationCompatible,
  parseAvatarComposerUrl,
  updateAvatarComposerConfig,
  type AvatarComposerConfig,
} from "../agent-avatar";

describe("agent avatar composer", () => {
  it("round-trips every supported background-free combination", () => {
    const urls = new Set<string>();

    for (const face of AVATAR_COMPOSER_FACE_SHAPES) {
      for (const hair of AVATAR_COMPOSER_HAIR_STYLES) {
        for (const expression of AVATAR_COMPOSER_EXPRESSIONS) {
          if (!isAvatarComposerCombinationCompatible(hair, expression)) {
            continue;
          }
          for (const skin of AVATAR_COMPOSER_SKIN_TONES) {
            for (const hairColor of AVATAR_COMPOSER_HAIR_COLORS) {
              const config: AvatarComposerConfig = {
                face,
                hair,
                expression,
                skin,
                hairColor,
              };
              const url = avatarComposerUrl(config);

              expect(new URL(url).searchParams.has("background")).toBe(false);
              expect(parseAvatarComposerUrl(url)).toStrictEqual(config);
              urls.add(url);
            }
          }
        }
      }
    }

    expect(urls.size).toBe(33_150);
  });

  it("repairs the hairstyle when a bearded expression is selected", () => {
    const config: AvatarComposerConfig = {
      face: "round",
      hair: "high-bun",
      expression: "neutral-smile",
      skin: "gold",
      hairColor: "blue",
    };

    const next = updateAvatarComposerConfig(config, {
      field: "expression",
      value: "full-beard",
    });

    expect(next.expression).toBe("full-beard");
    expect(
      isAvatarComposerCombinationCompatible(next.hair, next.expression),
    ).toBe(true);
    expect(
      updateAvatarComposerConfig(next, {
        field: "hair",
        value: "high-bun",
      }),
    ).toBe(next);
  });

  it("rejects unsupported or incompatible composer URLs", () => {
    const base = avatarComposerUrl({
      face: "round",
      hair: "high-bun",
      expression: "neutral-smile",
      skin: "gold",
      hairColor: "blue",
    });

    expect(
      parseAvatarComposerUrl(base.replace("face=round", "face=triangle")),
    ).toBeNull();
    expect(
      parseAvatarComposerUrl(
        base.replace("expression=neutral-smile", "expression=full-beard"),
      ),
    ).toBeNull();
    expect(parseAvatarComposerUrl("svg:r1s0h1c1f1d")).toBeNull();
  });
});
