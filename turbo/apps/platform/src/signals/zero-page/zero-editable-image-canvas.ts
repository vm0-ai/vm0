import { command, computed, state } from "ccstate";

export const PRIMARY_IMAGE_ITEM_ID = "primary-image";
export const DEFAULT_CANVAS_WIDTH = 1600;
export const DEFAULT_CANVAS_HEIGHT = 1200;
const DEFAULT_IMAGE_WIDTH = 720;
const DEFAULT_IMAGE_HEIGHT = 540;

const DUPLICATE_OFFSET = 24;

export type EditableImageCanvasItem = {
  height: number;
  id: string;
  src: string;
  width: number;
  x: number;
  y: number;
  zIndex: number;
};

const internalItemsByKey$ = state<Record<string, EditableImageCanvasItem[]>>(
  {},
);
const internalSelectedItemId$ = state<string | null>(null);
const internalClipboardItemByKey$ = state<
  Record<string, EditableImageCanvasItem | null>
>({});
const internalNextItemIndexByKey$ = state<Record<string, number>>({});

export const editableImageCanvasItemsByKey$ = computed((get) => {
  return get(internalItemsByKey$);
});

export const editableImageCanvasSelectedItemId$ = computed((get) => {
  return get(internalSelectedItemId$);
});

export function createInitialEditableImageCanvasItem(
  src: string,
): EditableImageCanvasItem {
  return {
    height: DEFAULT_IMAGE_HEIGHT,
    id: PRIMARY_IMAGE_ITEM_ID,
    src,
    width: DEFAULT_IMAGE_WIDTH,
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

export const selectEditableImageCanvasItem$ = command(
  ({ set }, itemId: string | null) => {
    set(internalSelectedItemId$, itemId);
  },
);

export const resetEditableImageCanvas$ = command(
  ({ set }, key: string, src: string) => {
    set(internalItemsByKey$, (current) => {
      return { ...current, [key]: [createInitialEditableImageCanvasItem(src)] };
    });
    set(internalSelectedItemId$, null);
    set(internalClipboardItemByKey$, (current) => {
      return { ...current, [key]: null };
    });
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [key]: 1 };
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
  },
);

export const resizeEditableImageCanvasItem$ = command(
  (
    { set },
    args: {
      height: number;
      itemId: string;
      key: string;
      src: string;
      width: number;
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

          const centerX = item.x + item.width / 2;
          const centerY = item.y + item.height / 2;
          return {
            ...item,
            height: args.height,
            width: args.width,
            x: Math.round(centerX - args.width / 2),
            y: Math.round(centerY - args.height / 2),
          };
        }),
      };
    });
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
    set(internalSelectedItemId$, duplicate.id);
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [key]: itemIndex + 1 };
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

    set(internalItemsByKey$, (current) => {
      return { ...current, [args.key]: [...items, item] };
    });
    set(internalSelectedItemId$, item.id);
    set(internalNextItemIndexByKey$, (current) => {
      return { ...current, [args.key]: itemIndex + 1 };
    });
  },
);
