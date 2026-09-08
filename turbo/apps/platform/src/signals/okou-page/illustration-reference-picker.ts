import type { ImageReferenceVisibility } from "@okouai/api-contracts/contracts/image-references";
import { command, computed, type Command, type Computed } from "ccstate";

import { authenticatedIdentity$, currentOrgInfo$ } from "../auth.ts";
import { logger } from "../log.ts";
import { settle } from "../utils.ts";
import type {
  ImageReferenceImageSignals,
  ImageReferenceLibrarySignals,
  ImageReferencePickerItem,
} from "./image-reference-library.ts";
import {
  createImageReferencePickerState,
  type ImageReferencePickerState,
} from "./image-reference-picker-state.ts";

const log = logger("illustration-reference-picker");

export interface IllustrationReferencePickerItem {
  readonly id: string;
  readonly title: string;
  readonly visibility: ImageReferenceVisibility;
  readonly creatorName: string | null;
  readonly previewUrl: string;
  readonly canManage: boolean;
  readonly canUnshare: boolean;
  readonly cardImage: ImageReferenceImageSignals;
  readonly detailImage: ImageReferenceImageSignals;
}

export interface IllustrationReferencePickerCatalog {
  readonly organizationName: string;
  readonly own: readonly IllustrationReferencePickerItem[];
  readonly organization: readonly IllustrationReferencePickerItem[];
}

export type ImageReferencePickerUpdate =
  | { readonly title: string }
  | { readonly visibility: ImageReferenceVisibility };

export interface IllustrationReferencePickerSignals {
  readonly state: ImageReferencePickerState;
  readonly catalog$: Computed<Promise<IllustrationReferencePickerCatalog>>;
  readonly createReference$: Command<Promise<void>, [AbortSignal]>;
  readonly updateReference$: Command<
    Promise<void>,
    [string, ImageReferencePickerUpdate, AbortSignal]
  >;
  readonly deleteReference$: Command<Promise<void>, [string, AbortSignal]>;
  readonly refreshCatalog$: Command<Promise<void>, [AbortSignal]>;
}

function pickerItem(
  item: ImageReferencePickerItem,
  ownedByCurrentUser: boolean,
): IllustrationReferencePickerItem {
  return {
    id: item.reference.id,
    title: item.reference.title,
    visibility: item.reference.visibility,
    creatorName: ownedByCurrentUser
      ? null
      : (item.creator?.displayName ?? null),
    previewUrl: item.reference.previewAsset.url,
    canManage: item.reference.canManage,
    canUnshare: item.reference.canModerate,
    cardImage: item.imageBuffers.card,
    detailImage: item.imageBuffers.detail,
  };
}

function createPickerCatalog$(library: ImageReferenceLibrarySignals) {
  return computed(async (get): Promise<IllustrationReferencePickerCatalog> => {
    const [items, identity, organization] = await Promise.all([
      get(library.pickerItems$),
      get(authenticatedIdentity$),
      get(currentOrgInfo$),
    ]);
    const own: IllustrationReferencePickerItem[] = [];
    const shared: IllustrationReferencePickerItem[] = [];
    for (const item of items) {
      const ownedByCurrentUser = item.reference.ownerUserId === identity.userId;
      (ownedByCurrentUser ? own : shared).push(
        pickerItem(item, ownedByCurrentUser),
      );
    }
    return {
      organizationName: organization?.name ?? "",
      own,
      organization: shared,
    };
  });
}

function createUploadCommand(
  library: ImageReferenceLibrarySignals,
  state: ImageReferencePickerState,
) {
  return command(
    async ({ get, set }, parentSignal: AbortSignal): Promise<void> => {
      const signal = set(state.beginUploadAttempt$, parentSignal);
      const rendered = await settle(
        set(state.renderReviewedImage$, signal),
        signal,
      );
      if (!rendered.ok) {
        set(state.markUploadFailed$, rendered.error);
        log.warn("reference image review failed", rendered.error);
        return;
      }
      const draft = get(state.uploadDraft$);
      if (!draft) {
        set(
          state.markUploadFailed$,
          new Error("Reference image review was closed before upload"),
        );
        return;
      }
      set(state.markUploading$);
      const uploaded = await settle(
        set(
          library.uploadAndCreate$,
          {
            file: rendered.value.file,
            title: draft.title.trim(),
            visibility: draft.visibility,
          },
          signal,
        ),
        signal,
      );
      if (!uploaded.ok) {
        set(state.markUploadFailed$, uploaded.error);
        log.warn("reference image upload failed", uploaded.error);
        return;
      }
      set(state.markUploadComplete$);
      set(state.setUploadDialogOpen$, false);
    },
  );
}

function createUpdateCommand(library: ImageReferenceLibrarySignals) {
  return command(
    async (
      { get, set },
      referenceId: string,
      update: ImageReferencePickerUpdate,
      signal: AbortSignal,
    ): Promise<void> => {
      if ("title" in update) {
        await set(library.rename$, referenceId, update.title, signal);
        return;
      }
      const reference = await get(library.resolve(referenceId));
      signal.throwIfAborted();
      if (
        update.visibility === "private" &&
        reference?.canModerate === true &&
        reference.canManage === false
      ) {
        await set(library.adminUnshare$, referenceId, signal);
        return;
      }
      await set(library.setVisibility$, referenceId, update.visibility, signal);
    },
  );
}

export function createIllustrationReferencePickerSignals(
  library: ImageReferenceLibrarySignals,
): IllustrationReferencePickerSignals {
  const state = createImageReferencePickerState();
  const deleteReference$ = command(
    async (
      { set },
      referenceId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      await set(library.delete$, referenceId, signal);
      set(state.setDetailReferenceId$, null);
    },
  );
  const refreshCatalog$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      await set(library.refresh$, signal);
    },
  );
  return {
    state,
    catalog$: createPickerCatalog$(library),
    createReference$: createUploadCommand(library, state),
    updateReference$: createUpdateCommand(library),
    deleteReference$,
    refreshCatalog$,
  };
}
