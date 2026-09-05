import { describe, expect, it } from "vitest";

import {
  HEYGEN_INTRO_VIDEO_AVATARS,
  INTRO_VIDEO_AVATARS,
  isHeyGenIntroVideoAvatarId,
} from "../intro-video-avatars";

describe("intro video avatars", () => {
  it("keeps exactly 30 distinct curated HeyGen looks behind placeholders", () => {
    expect(HEYGEN_INTRO_VIDEO_AVATARS).toHaveLength(30);
    expect(
      new Set(
        HEYGEN_INTRO_VIDEO_AVATARS.map((avatar) => {
          return avatar.avatarId;
        }),
      ).size,
    ).toBe(30);
    expect(
      new Set(
        HEYGEN_INTRO_VIDEO_AVATARS.map((avatar) => {
          return avatar.groupId;
        }),
      ).size,
    ).toBe(30);
    expect(
      HEYGEN_INTRO_VIDEO_AVATARS.every((avatar) => {
        return avatar.previewUrl === undefined;
      }),
    ).toBe(true);
  });

  it("records the fixed v3 render contract without validating alpha", () => {
    for (const avatar of HEYGEN_INTRO_VIDEO_AVATARS) {
      expect(avatar.preferredOrientation).toBe("landscape");
      expect(avatar.renderEngine).toBe("avatar_iii");
      expect(avatar.transparentBackgroundValidated).toBe(false);
      expect(avatar.defaultVoiceId).not.toBe("");
    }
  });

  it("uses provider-qualified keys for the combined Intro Video catalog", () => {
    expect(
      new Set(
        INTRO_VIDEO_AVATARS.map((avatar) => {
          return avatar.key;
        }),
      ).size,
    ).toBe(INTRO_VIDEO_AVATARS.length);
    expect(
      INTRO_VIDEO_AVATARS.every((avatar) => {
        return avatar.key === `${avatar.provider}:${avatar.avatarId}`;
      }),
    ).toBe(true);
  });

  it("recognizes only curated HeyGen look IDs", () => {
    expect(isHeyGenIntroVideoAvatarId("Abigail_standing_office_front")).toBe(
      true,
    );
    expect(isHeyGenIntroVideoAvatarId("private_or_removed_look")).toBe(false);
  });
});
