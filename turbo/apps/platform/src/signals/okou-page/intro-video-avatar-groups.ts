import type {
  IntroVideoAvatar,
  IntroVideoAvatarType,
} from "@okouai/api-contracts/contracts/intro-video-presenter";
import { command, computed, state } from "ccstate";

export interface IntroVideoAvatarGroup {
  readonly id: string;
  readonly name: string;
  readonly avatarType: IntroVideoAvatarType | undefined;
  readonly looks: readonly [IntroVideoAvatar, ...IntroVideoAvatar[]];
}

interface IntroVideoAvatarSection {
  readonly avatarType: IntroVideoAvatarType | undefined;
  readonly groups: readonly [IntroVideoAvatarGroup, ...IntroVideoAvatarGroup[]];
}

/**
 * HeyGen generates a photo avatar together with its environment and records a
 * digital twin in a real one, while a studio avatar is a transparent cutout the
 * provider places on the style's stage. Offer the scene-carrying types first.
 */
const AVATAR_TYPE_ORDER: readonly IntroVideoAvatarType[] = [
  "photo_avatar",
  "digital_twin",
  "studio_avatar",
];

function groupIntroVideoAvatars(
  avatars: readonly IntroVideoAvatar[],
): readonly IntroVideoAvatarGroup[] {
  const groups = new Map<string, [IntroVideoAvatar, ...IntroVideoAvatar[]]>();
  for (const avatar of avatars) {
    const looks = groups.get(avatar.groupId);
    if (!looks) {
      groups.set(avatar.groupId, [avatar]);
    } else if (
      !looks.some((look) => {
        return look.id === avatar.id;
      })
    ) {
      looks.push(avatar);
    }
  }
  return [...groups].map(([id, looks]) => {
    const first = looks[0];
    // Shorten the provider's outfit label for display only. Identity grouping
    // always uses groupId, including when two different people share a name.
    const separator = first.name.indexOf(" in ");
    const name =
      separator === -1 ? first.name : first.name.slice(0, separator).trim();
    return { id, name, avatarType: first.avatarType, looks };
  });
}

export function groupIntroVideoAvatarsByType(
  avatars: readonly IntroVideoAvatar[],
): readonly IntroVideoAvatarSection[] {
  const sections = new Map<
    IntroVideoAvatarType | undefined,
    [IntroVideoAvatarGroup, ...IntroVideoAvatarGroup[]]
  >();
  for (const group of groupIntroVideoAvatars(avatars)) {
    const existing = sections.get(group.avatarType);
    if (existing) {
      existing.push(group);
    } else {
      sections.set(group.avatarType, [group]);
    }
  }
  // An API released before the catalog change reports no look type; keep those
  // looks visible after the typed sections instead of hiding them.
  return [...AVATAR_TYPE_ORDER, undefined].flatMap((avatarType) => {
    const groups = sections.get(avatarType);
    return groups ? [{ avatarType, groups }] : [];
  });
}

function createIntroVideoAvatarGroupSignals() {
  const previewLookIds$ = state<Readonly<Record<string, string>>>({});
  return {
    previewLookIds$: computed((get) => {
      return get(previewLookIds$);
    }),
    previewLook$: command(
      (
        { set },
        selection: { readonly groupId: string; readonly lookId: string },
      ) => {
        set(previewLookIds$, (current) => {
          return {
            ...current,
            [selection.groupId]: selection.lookId,
          };
        });
      },
    ),
  };
}

export const introVideoAvatarGroupSignals =
  createIntroVideoAvatarGroupSignals();
