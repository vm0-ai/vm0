import type { IntroVideoAvatar } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { command, computed, state } from "ccstate";

export interface IntroVideoAvatarGroup {
  readonly id: string;
  readonly name: string;
  readonly looks: readonly IntroVideoAvatar[];
}

export function groupIntroVideoAvatars(
  avatars: readonly IntroVideoAvatar[],
): readonly IntroVideoAvatarGroup[] {
  const groups = new Map<string, IntroVideoAvatar[]>();
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
  return [...groups].flatMap(([id, looks]) => {
    const first = looks[0];
    if (!first) {
      return [];
    }
    // Shorten the provider's outfit label for display only. Identity grouping
    // always uses groupId, including when two different people share a name.
    const name = first.name.split(" in ")[0]?.trim() || first.name;
    return [{ id, name, looks }];
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
