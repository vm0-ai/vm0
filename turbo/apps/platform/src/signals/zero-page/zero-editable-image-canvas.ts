import { command, computed, state } from "ccstate";
import { ZERO_IMAGE_INTERPRET_MARKS_MAX_REGIONS } from "@vm0/api-contracts/contracts/zero-image-io-interpret-marks";

export const PRIMARY_IMAGE_ITEM_ID = "primary-image";
export const DEFAULT_CANVAS_WIDTH = 1600;
export const DEFAULT_CANVAS_HEIGHT = 1200;
const DEFAULT_IMAGE_WIDTH = 720;
const DEFAULT_IMAGE_HEIGHT = 540;

const DUPLICATE_OFFSET = 24;

export type EditableImageCanvasItem = {
  dimensionsResolved: boolean;
  dimensionsViewportKey: string | null;
  displayHeight: number;
  displayWidth: number;
  id: string;
  naturalHeight: number;
  naturalWidth: number;
  preservePositionOnLoad: boolean;
  src: string;
  x: number;
  y: number;
  zIndex: number;
};

export type EditableImageCanvasSnapshotItem = {
  url: string;
  x: number;
  y: number;
  zIndex: number;
};

export type EditableImageCanvasSnapshot = {
  items: readonly EditableImageCanvasSnapshotItem[];
  version: 1;
};

export type EditableImageCanvasRegion = {
  height: number;
  itemId: string;
  width: number;
  x: number;
  y: number;
};

export type EditableImageCanvasRegionComment = {
  id: string;
  instruction: string;
  region: EditableImageCanvasRegion;
};

const internalItemsByKey$ = state<Record<string, EditableImageCanvasItem[]>>(
  {},
);
const internalSnapshotByKey$ = state<
  Record<string, EditableImageCanvasSnapshot>
>({});
const internalMutationRevisionByKey$ = state<Record<string, number>>({});
const internalSelectedItemId$ = state<string | null>(null);
const internalClipboardItemByKey$ = state<
  Record<string, EditableImageCanvasItem | null>
>({});
const internalNextItemIndexByKey$ = state<Record<string, number>>({});
const internalRegionSelectionActiveByKey$ = state<Record<string, boolean>>({});
const internalRegionSelectionByKey$ = state<
  Record<string, EditableImageCanvasRegion | null>
>({});
const internalRegionInstructionDraftByKey$ = state<Record<string, string>>({});
const internalRegionCommentsByKey$ = state<
  Record<string, EditableImageCanvasRegionComment[]>
>({});
const internalEditingRegionCommentIdByKey$ = state<
  Record<string, string | null>
>({});
const internalNextRegionCommentIndexByKey$ = state<Record<string, number>>({});

export const editableImageCanvasItemsByKey$ = computed((get) => {
  return get(internalItemsByKey$);
});

export const editableImageCanvasSnapshotsByKey$ = computed((get) => {
  return get(internalSnapshotByKey$);
});

export const editableImageCanvasMutationRevisionsByKey$ = computed((get) => {
  return get(internalMutationRevisionByKey$);
});

export const editableImageCanvasSelectedItemId$ = computed((get) => {
  return get(internalSelectedItemId$);
});

export const editableImageCanvasRegionSelectionActiveByKey$ = computed(
  (get) => {
    return get(internalRegionSelectionActiveByKey$);
  },
);

export const editableImageCanvasRegionSelectionByKey$ = computed((get) => {
  return get(internalRegionSelectionByKey$);
});

export const editableImageCanvasRegionInstructionDraftByKey$ = computed(
  (get) => {
    return get(internalRegionInstructionDraftByKey$);
  },
);

export const editableImageCanvasRegionCommentsByKey$ = computed((get) => {
  return get(internalRegionCommentsByKey$);
});

export function createInitialEditableImageCanvasItem(
  src: string,
): EditableImageCanvasItem {
  return {
    dimensionsResolved: false,
    dimensionsViewportKey: null,
    displayHeight: DEFAULT_IMAGE_HEIGHT,
    displayWidth: DEFAULT_IMAGE_WIDTH,
    id: PRIMARY_IMAGE_ITEM_ID,
    naturalHeight: DEFAULT_IMAGE_HEIGHT,
    naturalWidth: DEFAULT_IMAGE_WIDTH,
    preservePositionOnLoad: false,
    src,
    x: (DEFAULT_CANVAS_WIDTH - DEFAULT_IMAGE_WIDTH) / 2,
    y: (DEFAULT_CANVAS_HEIGHT - DEFAULT_IMAGE_HEIGHT) / 2,
    zIndex: 1,
  };
}

export function editableImageArtifactCanvasKey(url: string): string {
  return `artifact-sidebar:edit:${url}`;
}

function itemsForKey(
  current: Record<string, EditableImageCanvasItem[]>,
  key: string,
  src: string,
): EditableImageCanvasItem[] {
  return current[key] ?? [createInitialEditableImageCanvasItem(src)];
}

function snapshotFromItems(
  items: readonly EditableImageCanvasItem[],
): EditableImageCanvasSnapshot {
  return {
    items: items.map((item) => {
      return {
        url: item.src,
        x: item.x,
        y: item.y,
        zIndex: item.zIndex,
      };
    }),
    version: 1,
  };
}

function setSnapshotForItems(
  current: Record<string, EditableImageCanvasSnapshot>,
  key: string,
  items: readonly EditableImageCanvasItem[],
): Record<string, EditableImageCanvasSnapshot> {
  const snapshot = snapshotFromItems(items);
  if (snapshot.items.length > 0) {
    return { ...current, [key]: snapshot };
  }

  const next = { ...current };
  delete next[key];
  return next;
}

function itemsFromSnapshot(
  snapshot: EditableImageCanvasSnapshot,
  canvasSrc: string,
): EditableImageCanvasItem[] {
  let primaryImageAssigned = false;
  return snapshot.items.map((item, index) => {
    const primaryImage = !primaryImageAssigned && item.url === canvasSrc;
    if (primaryImage) {
      primaryImageAssigned = true;
    }

    return {
      ...createInitialEditableImageCanvasItem(item.url),
      id: primaryImage ? PRIMARY_IMAGE_ITEM_ID : `image-snapshot-${index + 1}`,
      preservePositionOnLoad: true,
      x: item.x,
      y: item.y,
      zIndex: item.zIndex,
    };
  });
}

const markEditableImageCanvasMutated$ = command(({ set }, key: string) => {
  set(internalMutationRevisionByKey$, (current) => {
    return { ...current, [key]: (current[key] ?? 0) + 1 };
  });
});

export const selectEditableImageCanvasItem$ = command(
  ({ set }, itemId: string | null) => {
    set(internalSelectedItemId$, itemId);
  },
);

export const clearEditableImageCanvasTransientState$ = command(
  ({ set }, key: string) => {
    set(internalSelectedItemId$, null);
    set(internalClipboardItemByKey$, (current) => {
      return { ...current, [key]: null };
    });
    set(internalNextRegionCommentIndexByKey$, (current) => {
      return { ...current, [key]: 1 };
    });
    set(internalRegionSelectionActiveByKey$, (current) => {
      return { ...current, [key]: false };
    });
    set(internalRegionSelectionByKey$, (current) => {
      return { ...current, [key]: null };
    });
    set(internalRegionInstructionDraftByKey$, (current) => {
      return { ...current, [key]: "" };
    });
    set(internalRegionCommentsByKey$, (current) => {
      return { ...current, [key]: [] };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      return { ...current, [key]: null };
    });
  },
);

export const saveEditableImageCanvasSnapshot$ = command(
  ({ get, set }, key: string, src: string) => {
    const items = itemsForKey(get(internalItemsByKey$), key, src);
    const snapshot = snapshotFromItems(items);
    set(internalSnapshotByKey$, (current) => {
      return setSnapshotForItems(current, key, items);
    });
    return snapshot;
  },
);

export const hydrateEditableImageCanvasSnapshot$ = command(
  (
    { set },
    key: string,
    src: string,
    snapshot: EditableImageCanvasSnapshot,
  ) => {
    const items = itemsFromSnapshot(snapshot, src);
    set(internalSnapshotByKey$, (current) => {
      return { ...current, [key]: snapshot };
    });
    set(internalItemsByKey$, (current) => {
      return { ...current, [key]: items };
    });
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [key]: items.length + 1 };
    });
    set(clearEditableImageCanvasTransientState$, key);
  },
);

export const hydrateEditableImageCanvas$ = command(
  ({ get, set }, key: string, src: string) => {
    const snapshot = get(internalSnapshotByKey$)[key];
    const items =
      snapshot === undefined
        ? [createInitialEditableImageCanvasItem(src)]
        : itemsFromSnapshot(snapshot, src);
    set(internalItemsByKey$, (current) => {
      return { ...current, [key]: items };
    });
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [key]: items.length + 1 };
    });
    set(clearEditableImageCanvasTransientState$, key);
  },
);

export const resetEditableImageCanvas$ = command(
  ({ set }, key: string, src: string) => {
    set(internalItemsByKey$, (current) => {
      return { ...current, [key]: [createInitialEditableImageCanvasItem(src)] };
    });
    set(internalSnapshotByKey$, (current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [key]: 1 };
    });
    set(markEditableImageCanvasMutated$, key);
    set(clearEditableImageCanvasTransientState$, key);
  },
);

export const startEditableImageCanvasRegionSelection$ = command(
  ({ set }, key: string) => {
    set(internalRegionSelectionActiveByKey$, (current) => {
      return { ...current, [key]: true };
    });
    set(internalRegionSelectionByKey$, (current) => {
      return { ...current, [key]: null };
    });
    set(internalRegionInstructionDraftByKey$, (current) => {
      return { ...current, [key]: "" };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      return { ...current, [key]: null };
    });
  },
);

export const setEditableImageCanvasRegionInstructionDraft$ = command(
  (
    { set },
    args: {
      instruction: string;
      key: string;
    },
  ) => {
    set(internalRegionInstructionDraftByKey$, (current) => {
      return { ...current, [args.key]: args.instruction };
    });
  },
);

export const addEditableImageCanvasRegionComment$ = command(
  (
    { get, set },
    args: {
      instruction: string;
      key: string;
      region: EditableImageCanvasRegion;
    },
  ): boolean => {
    const instruction = args.instruction.trim();
    if (!instruction) {
      return false;
    }
    const editingCommentId =
      get(internalEditingRegionCommentIdByKey$)[args.key] ?? null;
    const comments = get(internalRegionCommentsByKey$)[args.key] ?? [];
    const editingExistingComment =
      editingCommentId !== null &&
      comments.some((comment) => {
        return comment.id === editingCommentId;
      });

    // A brand-new comment beyond the interpret-marks region cap would be
    // rejected by the API with a 400, so block it up front and let the caller
    // surface a clear message. Editing an existing comment is always allowed.
    if (
      !editingExistingComment &&
      comments.length >= ZERO_IMAGE_INTERPRET_MARKS_MAX_REGIONS
    ) {
      return false;
    }

    if (editingExistingComment) {
      set(internalRegionCommentsByKey$, (current) => {
        return {
          ...current,
          [args.key]: comments.map((comment) => {
            if (comment.id !== editingCommentId) {
              return comment;
            }
            return {
              ...comment,
              instruction,
              region: args.region,
            };
          }),
        };
      });
    } else {
      const nextIndex =
        get(internalNextRegionCommentIndexByKey$)[args.key] ?? 1;
      set(internalRegionCommentsByKey$, (current) => {
        return {
          ...current,
          [args.key]: [
            ...comments,
            {
              id: `region-comment-${nextIndex}`,
              instruction,
              region: args.region,
            },
          ],
        };
      });
      set(internalNextRegionCommentIndexByKey$, (current) => {
        return { ...current, [args.key]: nextIndex + 1 };
      });
    }
    set(internalRegionSelectionActiveByKey$, (current) => {
      return { ...current, [args.key]: true };
    });
    set(internalRegionSelectionByKey$, (current) => {
      return { ...current, [args.key]: null };
    });
    set(internalRegionInstructionDraftByKey$, (current) => {
      return { ...current, [args.key]: "" };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      return { ...current, [args.key]: null };
    });
    return true;
  },
);

export const startEditingEditableImageCanvasRegionComment$ = command(
  (
    { get, set },
    args: {
      commentId: string;
      key: string;
    },
  ) => {
    const comment =
      get(internalRegionCommentsByKey$)[args.key]?.find((currentComment) => {
        return currentComment.id === args.commentId;
      }) ?? null;
    if (comment === null) {
      return;
    }

    set(internalSelectedItemId$, comment.region.itemId);
    set(internalRegionSelectionActiveByKey$, (current) => {
      return { ...current, [args.key]: false };
    });
    set(internalRegionSelectionByKey$, (current) => {
      return { ...current, [args.key]: comment.region };
    });
    set(internalRegionInstructionDraftByKey$, (current) => {
      return { ...current, [args.key]: comment.instruction };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      return { ...current, [args.key]: comment.id };
    });
  },
);

export const removeEditableImageCanvasRegionComment$ = command(
  (
    { set },
    args: {
      commentId: string;
      key: string;
    },
  ) => {
    set(internalRegionCommentsByKey$, (current) => {
      const comments = current[args.key] ?? [];
      return {
        ...current,
        [args.key]: comments.filter((comment) => {
          return comment.id !== args.commentId;
        }),
      };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      if (current[args.key] !== args.commentId) {
        return current;
      }
      return { ...current, [args.key]: null };
    });
  },
);

export const removeEditableImageCanvasRegionComments$ = command(
  (
    { set },
    args: {
      commentIds: readonly string[];
      key: string;
    },
  ) => {
    if (args.commentIds.length === 0) {
      return;
    }
    const commentIds = new Set(args.commentIds);
    set(internalRegionCommentsByKey$, (current) => {
      const comments = current[args.key] ?? [];
      return {
        ...current,
        [args.key]: comments.filter((comment) => {
          return !commentIds.has(comment.id);
        }),
      };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      const editingCommentId = current[args.key] ?? null;
      if (editingCommentId === null || !commentIds.has(editingCommentId)) {
        return current;
      }
      return { ...current, [args.key]: null };
    });
  },
);

export const setEditableImageCanvasRegionSelection$ = command(
  (
    { set },
    args: {
      key: string;
      region: EditableImageCanvasRegion | null;
    },
  ) => {
    set(internalRegionSelectionByKey$, (current) => {
      return { ...current, [args.key]: args.region };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      return { ...current, [args.key]: null };
    });
  },
);

export const completeEditableImageCanvasRegionSelection$ = command(
  (
    { set },
    args: {
      key: string;
      region: EditableImageCanvasRegion;
    },
  ) => {
    set(internalRegionSelectionActiveByKey$, (current) => {
      return { ...current, [args.key]: false };
    });
    set(internalRegionSelectionByKey$, (current) => {
      return { ...current, [args.key]: args.region };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      return { ...current, [args.key]: null };
    });
  },
);

export const cancelEditableImageCanvasRegionDraft$ = command(
  (
    { set },
    args: {
      keepSelectionActive: boolean;
      key: string;
    },
  ) => {
    set(internalRegionSelectionActiveByKey$, (current) => {
      return { ...current, [args.key]: args.keepSelectionActive };
    });
    set(internalRegionSelectionByKey$, (current) => {
      return { ...current, [args.key]: null };
    });
    set(internalRegionInstructionDraftByKey$, (current) => {
      return { ...current, [args.key]: "" };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      return { ...current, [args.key]: null };
    });
  },
);

export const clearEditableImageCanvasRegionSelection$ = command(
  ({ set }, key: string) => {
    set(internalRegionSelectionActiveByKey$, (current) => {
      return { ...current, [key]: false };
    });
    set(internalRegionSelectionByKey$, (current) => {
      return { ...current, [key]: null };
    });
    set(internalRegionInstructionDraftByKey$, (current) => {
      return { ...current, [key]: "" };
    });
    set(internalEditingRegionCommentIdByKey$, (current) => {
      return { ...current, [key]: null };
    });
  },
);

export const moveEditableImageCanvasItem$ = command(
  (
    { set },
    args: {
      itemId: string;
      key: string;
      src: string;
      x: number;
      y: number;
    },
  ) => {
    set(internalItemsByKey$, (current) => {
      const items = itemsForKey(current, args.key, args.src);
      return {
        ...current,
        [args.key]: items.map((item) => {
          if (item.id !== args.itemId) {
            return item;
          }
          return { ...item, x: args.x, y: args.y };
        }),
      };
    });
    set(markEditableImageCanvasMutated$, args.key);
  },
);

// Fit a natural image inside a display box without distortion: keep the box's
// footprint but honor the image's own aspect ratio. Used when replacing an item
// in place (edit results can come back at a different aspect than the source
// they sit on, and the <img> renders with both width and height fixed).
function fitWithinDisplayBox(args: {
  boxHeight: number;
  boxWidth: number;
  naturalHeight: number;
  naturalWidth: number;
}): { displayHeight: number; displayWidth: number } {
  if (args.naturalWidth <= 0 || args.naturalHeight <= 0) {
    return { displayHeight: args.boxHeight, displayWidth: args.boxWidth };
  }
  const scale = Math.min(
    args.boxWidth / args.naturalWidth,
    args.boxHeight / args.naturalHeight,
  );
  return {
    displayHeight: Math.max(1, Math.round(args.naturalHeight * scale)),
    displayWidth: Math.max(1, Math.round(args.naturalWidth * scale)),
  };
}

export const resizeEditableImageCanvasItem$ = command(
  (
    { set },
    args: {
      displayHeight: number;
      displayWidth: number;
      itemId: string;
      key: string;
      naturalHeight: number;
      naturalWidth: number;
      preserveDisplaySize?: boolean;
      preservePosition?: boolean;
      src: string;
      viewportKey: string;
    },
  ) => {
    set(internalItemsByKey$, (current) => {
      const items = itemsForKey(current, args.key, args.src);
      return {
        ...current,
        [args.key]: items.map((item) => {
          if (item.id !== args.itemId) {
            return item;
          }

          const centerX = item.x + item.displayWidth / 2;
          const centerY = item.y + item.displayHeight / 2;
          const { displayHeight, displayWidth } = args.preserveDisplaySize
            ? fitWithinDisplayBox({
                boxHeight: item.displayHeight,
                boxWidth: item.displayWidth,
                naturalHeight: args.naturalHeight,
                naturalWidth: args.naturalWidth,
              })
            : {
                displayHeight: args.displayHeight,
                displayWidth: args.displayWidth,
              };
          return {
            ...item,
            dimensionsResolved: true,
            dimensionsViewportKey: args.viewportKey,
            displayHeight,
            displayWidth,
            naturalHeight: args.naturalHeight,
            naturalWidth: args.naturalWidth,
            x: args.preservePosition
              ? item.x
              : Math.round(centerX - displayWidth / 2),
            y: args.preservePosition
              ? item.y
              : Math.round(centerY - displayHeight / 2),
          };
        }),
      };
    });
  },
);

export const deleteEditableImageCanvasItem$ = command(
  (
    { get, set },
    args: {
      itemId: string;
      key: string;
      src: string;
    },
  ) => {
    const items = itemsForKey(get(internalItemsByKey$), args.key, args.src);
    const nextItems = items.filter((item) => {
      return item.id !== args.itemId;
    });
    const comments = get(internalRegionCommentsByKey$)[args.key] ?? [];
    const editingCommentId =
      get(internalEditingRegionCommentIdByKey$)[args.key] ?? null;
    const deletingEditingComment =
      editingCommentId !== null &&
      comments.some((comment) => {
        return (
          comment.id === editingCommentId &&
          comment.region.itemId === args.itemId
        );
      });
    set(internalItemsByKey$, (current) => {
      return {
        ...current,
        [args.key]: nextItems,
      };
    });
    set(markEditableImageCanvasMutated$, args.key);
    set(internalSnapshotByKey$, (current) => {
      return setSnapshotForItems(current, args.key, nextItems);
    });
    if (get(internalSelectedItemId$) === args.itemId) {
      set(internalSelectedItemId$, null);
    }
    if (get(internalRegionSelectionByKey$)[args.key]?.itemId === args.itemId) {
      set(internalRegionSelectionActiveByKey$, (current) => {
        return { ...current, [args.key]: false };
      });
      set(internalRegionSelectionByKey$, (current) => {
        return { ...current, [args.key]: null };
      });
      set(internalRegionInstructionDraftByKey$, (current) => {
        return { ...current, [args.key]: "" };
      });
    }
    set(internalRegionCommentsByKey$, (current) => {
      return {
        ...current,
        [args.key]: comments.filter((comment) => {
          return comment.region.itemId !== args.itemId;
        }),
      };
    });
    if (deletingEditingComment) {
      set(internalEditingRegionCommentIdByKey$, (current) => {
        return { ...current, [args.key]: null };
      });
    }
  },
);

export const copyEditableImageCanvasSelection$ = command(
  ({ get, set }, key: string, src: string) => {
    const items = itemsForKey(get(internalItemsByKey$), key, src);
    const selectedItemId = get(internalSelectedItemId$);
    if (selectedItemId === null) {
      return;
    }

    const selectedItem =
      items.find((item) => {
        return item.id === selectedItemId;
      }) ?? null;

    if (selectedItem === null) {
      return;
    }

    set(internalClipboardItemByKey$, (current) => {
      return { ...current, [key]: selectedItem };
    });
  },
);

export const pasteEditableImageCanvasSelection$ = command(
  ({ get, set }, key: string, src: string) => {
    const clipboardItem = get(internalClipboardItemByKey$)[key] ?? null;
    if (clipboardItem === null) {
      return;
    }

    const itemIndex = get(internalNextItemIndexByKey$)[key] ?? 1;
    const items = itemsForKey(get(internalItemsByKey$), key, src);
    const duplicate = {
      ...clipboardItem,
      id: `image-copy-${itemIndex}`,
      x: clipboardItem.x + DUPLICATE_OFFSET,
      y: clipboardItem.y + DUPLICATE_OFFSET,
      zIndex:
        Math.max(
          0,
          ...items.map((item) => {
            return item.zIndex;
          }),
        ) + 1,
    };

    set(internalItemsByKey$, (current) => {
      return { ...current, [key]: [...items, duplicate] };
    });
    set(markEditableImageCanvasMutated$, key);
    set(internalSelectedItemId$, duplicate.id);
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [key]: itemIndex + 1 };
    });
  },
);

export const insertEditableImageCanvasItem$ = command(
  (
    { get, set },
    args: {
      canvasSrc: string;
      key: string;
      src: string;
    },
  ) => {
    const items = itemsForKey(
      get(internalItemsByKey$),
      args.key,
      args.canvasSrc,
    );
    const itemIndex = get(internalNextItemIndexByKey$)[args.key] ?? 1;
    const base = createInitialEditableImageCanvasItem(args.src);
    const offset = DUPLICATE_OFFSET * items.length;
    const item = {
      ...base,
      id: `image-upload-${itemIndex}`,
      x: base.x + offset,
      y: base.y + offset,
      zIndex:
        Math.max(
          0,
          ...items.map((currentItem) => {
            return currentItem.zIndex;
          }),
        ) + 1,
    };
    const nextItems = [...items, item];

    set(internalItemsByKey$, (current) => {
      return { ...current, [args.key]: nextItems };
    });
    set(markEditableImageCanvasMutated$, args.key);
    set(internalSnapshotByKey$, (current) => {
      return setSnapshotForItems(current, args.key, nextItems);
    });
    set(internalSelectedItemId$, item.id);
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [args.key]: itemIndex + 1 };
    });
  },
);

export const addEditableImageCanvasItem$ = command(
  (
    { get, set },
    args: {
      canvasSrc: string;
      key: string;
      sourceItemId: string;
      src: string;
    },
  ) => {
    const items = itemsForKey(
      get(internalItemsByKey$),
      args.key,
      args.canvasSrc,
    );
    const sourceItem =
      items.find((item) => {
        return item.id === args.sourceItemId;
      }) ?? createInitialEditableImageCanvasItem(args.canvasSrc);
    const itemIndex = get(internalNextItemIndexByKey$)[args.key] ?? 1;
    const item = {
      ...sourceItem,
      dimensionsResolved: false,
      dimensionsViewportKey: null,
      id: `image-edit-${itemIndex}`,
      src: args.src,
      x: sourceItem.x + DUPLICATE_OFFSET,
      y: sourceItem.y + DUPLICATE_OFFSET,
      zIndex:
        Math.max(
          0,
          ...items.map((currentItem) => {
            return currentItem.zIndex;
          }),
        ) + 1,
    };
    const nextItems = [...items, item];

    set(internalItemsByKey$, (current) => {
      return { ...current, [args.key]: nextItems };
    });
    set(markEditableImageCanvasMutated$, args.key);
    set(internalSnapshotByKey$, (current) => {
      return setSnapshotForItems(current, args.key, nextItems);
    });
    set(internalSelectedItemId$, item.id);
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [args.key]: itemIndex + 1 };
    });
  },
);
