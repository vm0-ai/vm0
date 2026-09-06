import type { IntroVideoAvatar } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { command, computed, state } from "ccstate";

export interface IntroVideoAvatarGroup {
  readonly id: string;
  readonly name: string;
  readonly looks: readonly [IntroVideoAvatar, ...IntroVideoAvatar[]];
}

export function groupIntroVideoAvatars(
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
    return { id, name, looks };
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
