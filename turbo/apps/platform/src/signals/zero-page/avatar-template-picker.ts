import { command, computed, state } from "ccstate";
import {
  zeroAvatarVideoContract,
  type ZeroAvatarVideoAvatar,
} from "@vm0/api-contracts/contracts/zero-avatar-video";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

const AVATAR_TEMPLATE_PAGE_SIZE = 24;

interface AvatarTemplateCatalogPage {
  readonly avatars: readonly ZeroAvatarVideoAvatar[];
  readonly hasNext: boolean;
}

export function createAvatarTemplatePickerSignals() {
  const internalPage$ = state(1);
  const avatarTemplatePage$ = computed((get): number => {
    return get(internalPage$);
  });
  const avatarTemplateCatalogPage$ = computed(
    async (get): Promise<AvatarTemplateCatalogPage> => {
      const page = get(internalPage$);
      const client = get(zeroClient$)(zeroAvatarVideoContract, {
        apiBase: "api",
      });
      const result = await accept(
        client.avatars({
          query: { page, pageSize: AVATAR_TEMPLATE_PAGE_SIZE },
        }),
        [200],
      );
      return {
        avatars: result.body.avatars,
        hasNext: result.body.avatars.length === AVATAR_TEMPLATE_PAGE_SIZE,
      };
    },
  );
  const goToNextAvatarTemplatePage$ = command(({ get, set }) => {
    set(internalPage$, get(internalPage$) + 1);
  });
  const goToPreviousAvatarTemplatePage$ = command(({ get, set }) => {
    const page = get(internalPage$);
    if (page > 1) {
      set(internalPage$, page - 1);
    }
  });

  return {
    avatarTemplatePage$,
    avatarTemplateCatalogPage$,
    goToNextAvatarTemplatePage$,
    goToPreviousAvatarTemplatePage$,
  };
}
