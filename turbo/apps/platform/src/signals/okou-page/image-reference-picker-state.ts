import { command, computed, state, type State } from "ccstate";

import { onRef, resetSignal } from "../utils.ts";
import {
  type CanonicalReferenceImage,
  type ReferenceImageCrop,
  type ReferenceImageQuarterTurns,
  referenceImageTitleFromFilename,
  renderCanonicalReferenceImage,
  validateReferenceImageFile,
} from "./reference-image-canvas.ts";

type ImageReferenceVisibility = "private" | "public";

type ImageReferenceFileValidationError = "format" | "size";

type ImageReferenceUploadState =
  | { readonly status: "idle" }
  | { readonly status: "processing" }
  | { readonly status: "uploading" }
  | { readonly status: "failed"; readonly error: unknown };

interface ImageReferenceUploadDraft {
  readonly file: File;
  readonly previewUrl: string;
  readonly title: string;
  readonly visibility: ImageReferenceVisibility;
  readonly cropEnabled: boolean;
  readonly crop: ReferenceImageCrop;
  readonly quarterTurns: ReferenceImageQuarterTurns;
}

function revokeDraftPreview(draft: ImageReferenceUploadDraft | null): void {
  if (draft) {
    URL.revokeObjectURL(draft.previewUrl);
  }
}

function createUploadReviewFieldCommands(
  internalDraft$: State<ImageReferenceUploadDraft | null>,
) {
  const setUploadTitle$ = command(({ get, set }, title: string) => {
    const draft = get(internalDraft$);
    if (draft) {
      set(internalDraft$, { ...draft, title: title.slice(0, 80) });
    }
  });
  const setUploadVisibility$ = command(
    ({ get, set }, visibility: ImageReferenceVisibility) => {
      const draft = get(internalDraft$);
      if (draft) {
        set(internalDraft$, { ...draft, visibility });
      }
    },
  );
  const setCropEnabled$ = command(({ get, set }, cropEnabled: boolean) => {
    const draft = get(internalDraft$);
    if (draft) {
      set(internalDraft$, { ...draft, cropEnabled });
    }
  });
  const updateCrop$ = command(
    ({ get, set }, values: Partial<ReferenceImageCrop>) => {
      const draft = get(internalDraft$);
      if (draft) {
        set(internalDraft$, {
          ...draft,
          crop: { ...draft.crop, ...values },
        });
      }
    },
  );
  const rotateClockwise$ = command(({ get, set }) => {
    const draft = get(internalDraft$);
    if (draft) {
      set(internalDraft$, {
        ...draft,
        quarterTurns: ((draft.quarterTurns + 1) %
          4) as ReferenceImageQuarterTurns,
      });
    }
  });
  const resetReview$ = command(({ get, set }) => {
    const draft = get(internalDraft$);
    if (draft) {
      set(internalDraft$, {
        ...draft,
        cropEnabled: false,
        crop: { zoom: 1, x: 50, y: 50 },
        quarterTurns: 0,
      });
    }
  });
  return {
    setUploadTitle$,
    setUploadVisibility$,
    setCropEnabled$,
    updateCrop$,
    rotateClockwise$,
    resetReview$,
  };
}

function createUploadReviewSignals() {
  const internalUploadDialogOpen$ = state(false);
  const internalDraft$ = state<ImageReferenceUploadDraft | null>(null);
  const internalFileValidationError$ =
    state<ImageReferenceFileValidationError | null>(null);
  const resetUploadAttemptSignal$ = resetSignal();
  const uploadDialogOpen$ = computed((get) => {
    return get(internalUploadDialogOpen$);
  });
  const uploadDraft$ = computed((get) => {
    return get(internalDraft$);
  });
  const fileValidationError$ = computed((get) => {
    return get(internalFileValidationError$);
  });
  const selectUploadFile$ = command(({ get, set }, file: File): boolean => {
    const validation = validateReferenceImageFile(file);
    if (!validation.ok) {
      set(internalFileValidationError$, validation.reason);
      return false;
    }
    set(resetUploadAttemptSignal$);
    revokeDraftPreview(get(internalDraft$));
    set(internalDraft$, {
      file,
      previewUrl: URL.createObjectURL(file),
      title: referenceImageTitleFromFilename(file.name),
      visibility: "private",
      cropEnabled: false,
      crop: { zoom: 1, x: 50, y: 50 },
      quarterTurns: 0,
    });
    set(internalFileValidationError$, null);
    return true;
  });
  const clearUploadDraft$ = command(({ get, set }) => {
    set(resetUploadAttemptSignal$);
    revokeDraftPreview(get(internalDraft$));
    set(internalDraft$, null);
    set(internalFileValidationError$, null);
  });
  return {
    internalUploadDialogOpen$,
    internalDraft$,
    resetUploadAttemptSignal$,
    uploadDialogOpen$,
    uploadDraft$,
    fileValidationError$,
    selectUploadFile$,
    clearUploadDraft$,
    ...createUploadReviewFieldCommands(internalDraft$),
  };
}

function createUploadAttemptSignals(
  review: ReturnType<typeof createUploadReviewSignals>,
) {
  const internalUploadState$ = state<ImageReferenceUploadState>({
    status: "idle",
  });
  const uploadState$ = computed((get) => {
    return get(internalUploadState$);
  });
  const beginUploadAttempt$ = command(
    ({ set }, parentSignal: AbortSignal): AbortSignal => {
      const signal = set(review.resetUploadAttemptSignal$, parentSignal);
      set(internalUploadState$, { status: "processing" });
      return signal;
    },
  );
  const markUploading$ = command(({ set }) => {
    set(internalUploadState$, { status: "uploading" });
  });
  const markUploadFailed$ = command(({ set }, error: unknown) => {
    set(internalUploadState$, { status: "failed", error });
  });
  const markUploadComplete$ = command(({ set }) => {
    set(internalUploadState$, { status: "idle" });
  });
  const cancelUpload$ = command(({ get, set }) => {
    set(review.resetUploadAttemptSignal$);
    if (get(internalUploadState$).status !== "idle") {
      set(internalUploadState$, { status: "idle" });
    }
  });
  const renderReviewedImage$ = command(
    async ({ get }, signal: AbortSignal): Promise<CanonicalReferenceImage> => {
      const draft = get(review.internalDraft$);
      if (!draft) {
        throw new Error("Select a reference image before saving it.");
      }
      return await renderCanonicalReferenceImage(
        draft.file,
        draft.cropEnabled ? draft.crop : { zoom: 1, x: 50, y: 50 },
        draft.quarterTurns,
        signal,
      );
    },
  );
  return {
    uploadState$,
    beginUploadAttempt$,
    markUploading$,
    markUploadFailed$,
    markUploadComplete$,
    cancelUpload$,
    renderReviewedImage$,
  };
}

function createImageReferenceDetailSignals() {
  const internalDetailReferenceId$ = state<string | null>(null);
  const detailReferenceId$ = computed((get) => {
    return get(internalDetailReferenceId$);
  });
  const setDetailReferenceId$ = command(
    ({ set }, referenceId: string | null) => {
      set(internalDetailReferenceId$, referenceId);
    },
  );
  return { detailReferenceId$, setDetailReferenceId$ };
}

function createImageReferencePickerDomSignals() {
  const internalFileInput$ = state<HTMLInputElement | null>(null);
  const internalUploadTrigger$ = state<HTMLButtonElement | null>(null);
  const ownFileInput$ = command(
    ({ set }, element: HTMLInputElement, signal: AbortSignal) => {
      set(internalFileInput$, element);
      signal.addEventListener(
        "abort",
        () => {
          set(internalFileInput$, null);
        },
        { once: true },
      );
    },
  );
  const ownUploadTrigger$ = command(
    ({ set }, element: HTMLButtonElement, signal: AbortSignal) => {
      set(internalUploadTrigger$, element);
      signal.addEventListener(
        "abort",
        () => {
          set(internalUploadTrigger$, null);
        },
        { once: true },
      );
    },
  );
  const chooseUploadFile$ = command(({ get }) => {
    const input = get(internalFileInput$);
    if (input) {
      input.value = "";
      input.click();
    }
  });
  const restoreUploadTriggerFocus$ = command(({ get }) => {
    get(internalUploadTrigger$)?.focus();
  });
  return {
    fileInputRef$: onRef(ownFileInput$),
    uploadTriggerRef$: onRef(ownUploadTrigger$),
    chooseUploadFile$,
    restoreUploadTriggerFocus$,
  };
}

export function createImageReferencePickerState() {
  const review = createUploadReviewSignals();
  const attempt = createUploadAttemptSignals(review);
  const detail = createImageReferenceDetailSignals();
  const dom = createImageReferencePickerDomSignals();
  const setUploadDialogOpen$ = command(({ set }, open: boolean) => {
    set(review.internalUploadDialogOpen$, open);
    if (!open) {
      set(attempt.cancelUpload$);
      set(review.clearUploadDraft$);
    }
  });
  const selectUploadFile$ = command(({ set }, file: File): boolean => {
    set(attempt.cancelUpload$);
    return set(review.selectUploadFile$, file);
  });
  const ownUploadDialogLifecycle$ = command(
    ({ set }, _element: HTMLDivElement, signal: AbortSignal) => {
      signal.addEventListener(
        "abort",
        () => {
          set(attempt.cancelUpload$);
          set(review.clearUploadDraft$);
        },
        { once: true },
      );
    },
  );
  return {
    uploadDialogOpen$: review.uploadDialogOpen$,
    uploadDraft$: review.uploadDraft$,
    fileValidationError$: review.fileValidationError$,
    setUploadDialogOpen$,
    selectUploadFile$,
    setUploadTitle$: review.setUploadTitle$,
    setUploadVisibility$: review.setUploadVisibility$,
    setCropEnabled$: review.setCropEnabled$,
    updateCrop$: review.updateCrop$,
    rotateClockwise$: review.rotateClockwise$,
    resetReview$: review.resetReview$,
    ...detail,
    ...dom,
    ...attempt,
    uploadDialogLifecycleRef$: onRef(ownUploadDialogLifecycle$),
  };
}

export type ImageReferencePickerState = ReturnType<
  typeof createImageReferencePickerState
>;
