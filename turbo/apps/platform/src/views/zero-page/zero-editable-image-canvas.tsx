import type {
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  SyntheticEvent,
} from "react";
import {
  type ReactZoomPanPinchContextState,
  TransformComponent,
  TransformWrapper,
  useTransformComponent,
} from "react-zoom-pan-pinch";
import { useGet, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import {
  IMAGE_LIGHTBOX_MAX_ZOOM,
  IMAGE_LIGHTBOX_MIN_ZOOM,
  setZoomableImageCanvasZoom$,
  zoomableImageCanvasZoomByKey$,
} from "../../signals/view-component-state.ts";
import {
  cancelEditableImageCanvasRegionDraft$,
  clearEditableImageCanvasRegionSelection$,
  completeEditableImageCanvasRegionSelection$,
  copyEditableImageCanvasSelection$,
  createInitialEditableImageCanvasItem,
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  deleteEditableImageCanvasItem$,
  editableImageCanvasItemsByKey$,
  editableImageCanvasRegionCommentsByKey$,
  editableImageCanvasRegionSelectionActiveByKey$,
  editableImageCanvasRegionSelectionByKey$,
  editableImageCanvasSelectedItemId$,
  type EditableImageCanvasRegionComment,
  type EditableImageCanvasRegion,
  type EditableImageCanvasItem,
  moveEditableImageCanvasItem$,
  pasteEditableImageCanvasSelection$,
  PRIMARY_IMAGE_ITEM_ID,
  resizeEditableImageCanvasItem$,
  selectEditableImageCanvasItem$,
  setEditableImageCanvasRegionSelection$,
} from "../../signals/zero-page/zero-editable-image-canvas.ts";
import type { ZoomableImageControls } from "./zero-zoomable-image-canvas.tsx";

const IMAGE_ZOOM_STEP = 0.15;
const MAX_INITIAL_IMAGE_EDGE = 900;
const IMAGE_VIEWER_PADDING = 24;
const SELECTED_IMAGE_OUTLINE_WIDTH = 4;
const SELECTED_IMAGE_HALO_WIDTH = 3;
const TOOLBAR_OFFSET = 12;
const MIN_REGION_SELECTION_SIZE = 6;

type EditableImageCanvasProps = {
  alt: string;
  canvasKey: string;
  canvasTestId?: string;
  children?: (controls: ZoomableImageControls) => ReactNode;
  className?: string;
  imageTestId: string;
  renderRegionToolbar?: (
    region: EditableImageCanvasRegion,
    item: EditableImageCanvasItem,
  ) => ReactNode;
  renderRegionComment?: (
    comment: EditableImageCanvasRegionComment,
    item: EditableImageCanvasItem,
  ) => ReactNode;
  renderSelectionToolbar?: (item: EditableImageCanvasItem) => ReactNode;
  src: string;
  viewportKey: string;
};

type CanvasItemViewProps = {
  alt: string;
  imageTestId: string;
  item: EditableImageCanvasItem;
  onImageLoad: (
    itemId: string,
    event: SyntheticEvent<HTMLImageElement>,
  ) => void;
  onPointerDown: (
    item: EditableImageCanvasItem,
    event: PointerEvent<HTMLImageElement>,
  ) => void;
  selectingRegion: boolean;
  selected: boolean;
};

type EditableImageTransformFrameProps = {
  alt: string;
  canvasKey: string;
  canvasTestId: string;
  children?: (controls: ZoomableImageControls) => ReactNode;
  className?: string;
  displayZoom: number;
  imageTestId: string;
  items: EditableImageCanvasItem[];
  onImageLoad: (
    itemId: string,
    event: SyntheticEvent<HTMLImageElement>,
  ) => void;
  onItemPointerDown: (
    item: EditableImageCanvasItem,
    event: PointerEvent<HTMLImageElement>,
  ) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSurfacePointerDown: () => void;
  regionSelectionActive: boolean;
  regionComments: EditableImageCanvasRegionComment[];
  renderRegionComment?: (
    comment: EditableImageCanvasRegionComment,
    item: EditableImageCanvasItem,
  ) => ReactNode;
  renderRegionToolbar?: (
    region: EditableImageCanvasRegion,
    item: EditableImageCanvasItem,
  ) => ReactNode;
  renderSelectionToolbar?: (item: EditableImageCanvasItem) => ReactNode;
  selectedRegion: EditableImageCanvasRegion | null;
  selectedItem: EditableImageCanvasItem | null;
  selectedItemId: string | null;
  setDisplayZoom: (key: string, zoom: number) => void;
  viewportKey: string;
};

type RegionPointerPoint = {
  x: number;
  y: number;
};

type DisplayImageCanvasRegion = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type MoveImageCanvasItem = (args: {
  itemId: string;
  key: string;
  src: string;
  x: number;
  y: number;
}) => void;

type SelectImageCanvasItem = (itemId: string | null) => void;

type SetImageCanvasRegionSelection = (args: {
  key: string;
  region: EditableImageCanvasRegion | null;
}) => void;

type CompleteImageCanvasRegionSelection = (args: {
  key: string;
  region: EditableImageCanvasRegion;
}) => void;

type ClearImageCanvasRegionSelection = (key: string) => void;

function useEditableImageCanvasState(canvasKey: string, src: string) {
  const itemsByKey = useGet(editableImageCanvasItemsByKey$);
  const regionCommentsByKey = useGet(editableImageCanvasRegionCommentsByKey$);
  const regionSelectionActiveByKey = useGet(
    editableImageCanvasRegionSelectionActiveByKey$,
  );
  const regionSelectionByKey = useGet(editableImageCanvasRegionSelectionByKey$);
  const selectedItemId = useGet(editableImageCanvasSelectedItemId$);
  const zoomByKey = useGet(zoomableImageCanvasZoomByKey$);
  const cancelRegionDraft = useSet(cancelEditableImageCanvasRegionDraft$);
  const clearRegionSelection = useSet(clearEditableImageCanvasRegionSelection$);
  const completeRegionSelection = useSet(
    completeEditableImageCanvasRegionSelection$,
  );
  const copySelection = useSet(copyEditableImageCanvasSelection$);
  const deleteItem = useSet(deleteEditableImageCanvasItem$);
  const moveItem = useSet(moveEditableImageCanvasItem$);
  const pasteSelection = useSet(pasteEditableImageCanvasSelection$);
  const resizeItem = useSet(resizeEditableImageCanvasItem$);
  const selectItem = useSet(selectEditableImageCanvasItem$);
  const setRegionSelection = useSet(setEditableImageCanvasRegionSelection$);
  const setDisplayZoom = useSet(setZoomableImageCanvasZoom$);
  const items = itemsByKey[canvasKey] ?? [
    createInitialEditableImageCanvasItem(src),
  ];

  return {
    cancelRegionDraft,
    clearRegionSelection,
    completeRegionSelection,
    copySelection,
    deleteItem,
    displayZoom: zoomByKey[canvasKey] ?? 1,
    items,
    moveItem,
    pasteSelection,
    regionComments: regionCommentsByKey[canvasKey] ?? [],
    regionSelectionActive: regionSelectionActiveByKey[canvasKey] ?? false,
    resizeItem,
    selectedItem:
      items.find((item) => {
        return item.id === selectedItemId;
      }) ?? null,
    selectedItemId,
    selectedRegion: regionSelectionByKey[canvasKey] ?? null,
    selectItem,
    setDisplayZoom,
    setRegionSelection,
  };
}

type EditableImageCanvasState = ReturnType<typeof useEditableImageCanvasState>;

function clearEditableImageCanvasSurfaceSelection(
  canvasKey: string,
  canvasState: EditableImageCanvasState,
): void {
  if (
    canvasState.regionSelectionActive ||
    canvasState.selectedRegion !== null
  ) {
    canvasState.clearRegionSelection(canvasKey);
  }
  canvasState.selectItem(null);
}

function cancelPendingRegionComment(
  canvasKey: string,
  canvasState: EditableImageCanvasState,
  itemId: string,
): void {
  canvasState.cancelRegionDraft({
    keepSelectionActive: canvasState.selectedRegion?.itemId === itemId,
    key: canvasKey,
  });
  canvasState.selectItem(itemId);
}

function nextImageSize(image: HTMLImageElement) {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }

  const root = image.closest<HTMLElement>(
    "[data-editable-image-canvas-root='true']",
  );
  const availableWidth =
    root && root.clientWidth > IMAGE_VIEWER_PADDING * 2
      ? root.clientWidth - IMAGE_VIEWER_PADDING * 2
      : 0;
  const availableHeight =
    root && root.clientHeight > IMAGE_VIEWER_PADDING * 2
      ? root.clientHeight - IMAGE_VIEWER_PADDING * 2
      : 0;
  const widthScale = availableWidth > 0 ? availableWidth / naturalWidth : 1;
  const heightScale = availableHeight > 0 ? availableHeight / naturalHeight : 1;
  const fallbackScale =
    MAX_INITIAL_IMAGE_EDGE / Math.max(naturalWidth, naturalHeight);
  const scale =
    availableWidth > 0 || availableHeight > 0
      ? Math.min(1, widthScale, heightScale)
      : Math.min(1, fallbackScale);

  return {
    displayHeight: Math.round(naturalHeight * scale),
    displayWidth: Math.round(naturalWidth * scale),
    naturalHeight,
    naturalWidth,
  };
}

function controlsFromTransformState({
  displayZoom,
  resetTransform,
  setDisplayZoom,
  zoomIn,
  zoomKey,
  zoomOut,
}: {
  displayZoom: number;
  resetTransform: (animationTime?: number) => void;
  setDisplayZoom: (key: string, zoom: number) => void;
  zoomIn: (step?: number, animationTime?: number) => void;
  zoomKey: string;
  zoomOut: (step?: number, animationTime?: number) => void;
}): ZoomableImageControls {
  return {
    canZoomIn: displayZoom < IMAGE_LIGHTBOX_MAX_ZOOM,
    canZoomOut: displayZoom > IMAGE_LIGHTBOX_MIN_ZOOM,
    resetZoom: () => {
      resetTransform(0);
      setDisplayZoom(zoomKey, 1);
    },
    zoom: displayZoom,
    zoomIn: () => {
      zoomIn(IMAGE_ZOOM_STEP, 0);
    },
    zoomOut: () => {
      zoomOut(IMAGE_ZOOM_STEP, 0);
    },
  };
}

function isEditableTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function clampRegionCoordinate(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(max, value));
}

function regionPointerPoint(
  event: { clientX: number; clientY: number },
  image: HTMLImageElement,
  item: EditableImageCanvasItem,
): RegionPointerPoint {
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }

  return {
    x: clampRegionCoordinate(
      ((event.clientX - rect.left) / rect.width) * item.naturalWidth,
      item.naturalWidth,
    ),
    y: clampRegionCoordinate(
      ((event.clientY - rect.top) / rect.height) * item.naturalHeight,
      item.naturalHeight,
    ),
  };
}

function normalizeRegionSelection({
  current,
  item,
  origin,
}: {
  current: RegionPointerPoint;
  item: EditableImageCanvasItem;
  origin: RegionPointerPoint;
}): EditableImageCanvasRegion {
  const left = Math.round(Math.min(origin.x, current.x));
  const top = Math.round(Math.min(origin.y, current.y));
  const right = Math.round(Math.max(origin.x, current.x));
  const bottom = Math.round(Math.max(origin.y, current.y));
  return {
    height: bottom - top,
    itemId: item.id,
    width: right - left,
    x: left,
    y: top,
  };
}

function displayRegionFromNaturalRegion(
  region: EditableImageCanvasRegion,
  item: EditableImageCanvasItem,
): DisplayImageCanvasRegion {
  const scaleX =
    item.naturalWidth <= 0 ? 0 : item.displayWidth / item.naturalWidth;
  const scaleY =
    item.naturalHeight <= 0 ? 0 : item.displayHeight / item.naturalHeight;
  return {
    height: region.height * scaleY,
    width: region.width * scaleX,
    x: region.x * scaleX,
    y: region.y * scaleY,
  };
}

function displayRegionIsLargeEnough(region: DisplayImageCanvasRegion): boolean {
  return (
    region.width >= MIN_REGION_SELECTION_SIZE &&
    region.height >= MIN_REGION_SELECTION_SIZE
  );
}

function focusEditableImageCanvasRoot(image: HTMLImageElement): void {
  image
    .closest<HTMLElement>("[data-editable-image-canvas-root='true']")
    ?.focus();
}

function startRegionSelectionDrag({
  clearRegionSelection,
  completeRegionSelection,
  event,
  item,
  key,
  selectItem,
  setRegionSelection,
}: {
  clearRegionSelection: ClearImageCanvasRegionSelection;
  completeRegionSelection: CompleteImageCanvasRegionSelection;
  event: PointerEvent<HTMLImageElement>;
  item: EditableImageCanvasItem;
  key: string;
  selectItem: SelectImageCanvasItem;
  setRegionSelection: SetImageCanvasRegionSelection;
}): void {
  const image = event.currentTarget;
  const origin = regionPointerPoint(event, image, item);
  let latestRegion = normalizeRegionSelection({
    current: origin,
    item,
    origin,
  });
  selectItem(item.id);
  setRegionSelection({ key, region: latestRegion });

  const removeListeners = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopSelectingRegion);
    window.removeEventListener("pointercancel", cancelSelectingRegion);
  };
  function handlePointerMove(moveEvent: globalThis.PointerEvent) {
    latestRegion = normalizeRegionSelection({
      current: regionPointerPoint(moveEvent, image, item),
      item,
      origin,
    });
    setRegionSelection({ key, region: latestRegion });
  }
  function cancelSelectingRegion() {
    removeListeners();
    setRegionSelection({ key, region: null });
    clearRegionSelection(key);
  }
  function stopSelectingRegion() {
    removeListeners();
    if (
      !displayRegionIsLargeEnough(
        displayRegionFromNaturalRegion(latestRegion, item),
      )
    ) {
      setRegionSelection({ key, region: null });
      clearRegionSelection(key);
      return;
    }
    completeRegionSelection({ key, region: latestRegion });
  }

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", stopSelectingRegion);
  window.addEventListener("pointercancel", cancelSelectingRegion);
}

function startImageItemMoveDrag({
  displayZoom,
  event,
  item,
  key,
  moveItem,
  src,
}: {
  displayZoom: number;
  event: PointerEvent<HTMLImageElement>;
  item: EditableImageCanvasItem;
  key: string;
  moveItem: MoveImageCanvasItem;
  src: string;
}): void {
  const originClientX = event.clientX;
  const originClientY = event.clientY;
  const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
    moveItem({
      itemId: item.id,
      key,
      src,
      x: Math.round(item.x + (moveEvent.clientX - originClientX) / displayZoom),
      y: Math.round(item.y + (moveEvent.clientY - originClientY) / displayZoom),
    });
  };
  const stopDragging = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopDragging);
    window.removeEventListener("pointercancel", stopDragging);
  };

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", stopDragging);
  window.addEventListener("pointercancel", stopDragging);
}

function handleEditableImageCanvasKeyDown({
  canvasKey,
  canvasState,
  event,
  src,
}: {
  canvasKey: string;
  canvasState: EditableImageCanvasState;
  event: KeyboardEvent<HTMLDivElement>;
  src: string;
}): void {
  if (isEditableTextTarget(event.target)) {
    return;
  }

  if (
    event.key === "Escape" &&
    (canvasState.regionSelectionActive || canvasState.selectedRegion !== null)
  ) {
    event.preventDefault();
    canvasState.clearRegionSelection(canvasKey);
    return;
  }

  if (
    (event.key === "Backspace" || event.key === "Delete") &&
    canvasState.selectedItem !== null
  ) {
    event.preventDefault();
    canvasState.deleteItem({
      itemId: canvasState.selectedItem.id,
      key: canvasKey,
      src,
    });
    return;
  }

  const key = event.key.toLowerCase();
  const shortcutPressed = event.metaKey || event.ctrlKey;
  if (shortcutPressed && key === "c" && canvasState.selectedItem !== null) {
    event.preventDefault();
    canvasState.copySelection(canvasKey, src);
    return;
  }
  if (shortcutPressed && key === "v") {
    event.preventDefault();
    canvasState.pasteSelection(canvasKey, src);
  }
}

function CanvasItemView({
  alt,
  imageTestId,
  item,
  onImageLoad,
  onPointerDown,
  selectingRegion,
  selected,
}: CanvasItemViewProps) {
  const inverseScale = useTransformComponent(inverseScaleFromTransformState);
  const selectedImageOutlineWidth = SELECTED_IMAGE_OUTLINE_WIDTH * inverseScale;
  const selectedImageHaloWidth = SELECTED_IMAGE_HALO_WIDTH * inverseScale;

  return (
    <img
      src={item.src}
      alt={alt}
      data-testid={
        item.id === PRIMARY_IMAGE_ITEM_ID ? imageTestId : `${imageTestId}-copy`
      }
      draggable={false}
      onLoad={(event) => {
        onImageLoad(item.id, event);
      }}
      onPointerDown={(event) => {
        onPointerDown(item, event);
      }}
      className={cn(
        "image-edit-canvas-item absolute block max-w-none select-none touch-none",
        selectingRegion ? "cursor-crosshair" : "cursor-move",
      )}
      style={{
        boxShadow: selected
          ? `0 0 0 ${selectedImageHaloWidth}px rgba(255,255,255,0.88)`
          : undefined,
        left: item.x,
        outline: selected
          ? `${selectedImageOutlineWidth}px solid rgb(59,130,246)`
          : undefined,
        height: item.displayHeight,
        pointerEvents: "auto",
        top: item.y,
        userSelect: "none",
        width: item.displayWidth,
        zIndex: item.zIndex,
      }}
    />
  );
}

function inverseScaleFromTransformState({
  state,
}: ReactZoomPanPinchContextState): number {
  return 1 / state.scale;
}

function SelectionToolbarAnchor({
  renderSelectionToolbar,
  selectedItem,
}: {
  renderSelectionToolbar: (item: EditableImageCanvasItem) => ReactNode;
  selectedItem: EditableImageCanvasItem;
}) {
  const inverseScale = useTransformComponent(inverseScaleFromTransformState);

  return (
    <div
      className="image-edit-floating-toolbar absolute"
      style={{
        left: selectedItem.x + selectedItem.displayWidth / 2,
        top: selectedItem.y - TOOLBAR_OFFSET,
        zIndex: selectedItem.zIndex + 2,
      }}
    >
      <div className="-translate-x-1/2 -translate-y-full">
        <div
          data-testid="image-edit-toolbar-scale"
          style={{
            transform: `scale(${inverseScale})`,
            transformOrigin: "center bottom",
          }}
        >
          {renderSelectionToolbar(selectedItem)}
        </div>
      </div>
    </div>
  );
}

function RegionSelectionFrame({
  item,
  region,
}: {
  item: EditableImageCanvasItem;
  region: EditableImageCanvasRegion;
}) {
  const inverseScale = useTransformComponent(inverseScaleFromTransformState);
  const displayRegion = displayRegionFromNaturalRegion(region, item);
  if (!displayRegionIsLargeEnough(displayRegion)) {
    return null;
  }

  return (
    <div
      className="image-edit-region-selection pointer-events-none absolute rounded-sm bg-primary/15"
      data-testid="image-edit-region-selection"
      style={{
        height: displayRegion.height,
        left: item.x + displayRegion.x,
        outline: `${2 * inverseScale}px solid rgb(37,99,235)`,
        top: item.y + displayRegion.y,
        width: displayRegion.width,
        zIndex: item.zIndex + 1,
      }}
    />
  );
}

function RegionToolbarAnchor({
  item,
  region,
  renderRegionToolbar,
}: {
  item: EditableImageCanvasItem;
  region: EditableImageCanvasRegion;
  renderRegionToolbar: (
    region: EditableImageCanvasRegion,
    item: EditableImageCanvasItem,
  ) => ReactNode;
}) {
  const inverseScale = useTransformComponent(inverseScaleFromTransformState);
  const displayRegion = displayRegionFromNaturalRegion(region, item);
  if (!displayRegionIsLargeEnough(displayRegion)) {
    return null;
  }

  return (
    <div
      className="image-edit-region-toolbar absolute"
      style={{
        left: item.x + displayRegion.x + displayRegion.width / 2,
        top: item.y + displayRegion.y - TOOLBAR_OFFSET,
        zIndex: item.zIndex + 3,
      }}
    >
      <div className="-translate-x-1/2 -translate-y-full">
        <div
          data-testid="image-edit-region-toolbar-scale"
          style={{
            transform: `scale(${inverseScale})`,
            transformOrigin: "center bottom",
          }}
        >
          {renderRegionToolbar(region, item)}
        </div>
      </div>
    </div>
  );
}

function RegionCommentAnchor({
  comment,
  item,
  renderRegionComment,
}: {
  comment: EditableImageCanvasRegionComment;
  item: EditableImageCanvasItem;
  renderRegionComment: (
    comment: EditableImageCanvasRegionComment,
    item: EditableImageCanvasItem,
  ) => ReactNode;
}) {
  const inverseScale = useTransformComponent(inverseScaleFromTransformState);
  const displayRegion = displayRegionFromNaturalRegion(comment.region, item);
  if (!displayRegionIsLargeEnough(displayRegion)) {
    return null;
  }

  return (
    <div
      className="group pointer-events-none absolute"
      style={{
        height: displayRegion.height,
        left: item.x + displayRegion.x,
        top: item.y + displayRegion.y,
        width: displayRegion.width,
        zIndex: item.zIndex + 3,
      }}
    >
      <div
        data-testid="image-edit-region-comment-frame"
        className="absolute inset-0 rounded-sm border border-dashed border-blue-600/90 bg-blue-600/10 opacity-0 transition-opacity group-hover:opacity-100"
        style={{
          borderWidth: `${2 * inverseScale}px`,
        }}
      />
      <div className="pointer-events-auto absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div
          data-testid="image-edit-region-comment-scale"
          style={{
            transform: `scale(${inverseScale})`,
            transformOrigin: "center center",
          }}
        >
          {renderRegionComment(comment, item)}
        </div>
      </div>
    </div>
  );
}

function EditableCanvasSurface({
  alt,
  canvasTestId,
  imageTestId,
  items,
  onImageLoad,
  onItemPointerDown,
  onSurfacePointerDown,
  regionSelectionActive,
  regionComments,
  renderRegionComment,
  renderRegionToolbar,
  renderSelectionToolbar,
  selectedRegion,
  selectedItem,
  selectedItemId,
}: {
  alt: string;
  canvasTestId: string;
  imageTestId: string;
  items: EditableImageCanvasItem[];
  onImageLoad: (
    itemId: string,
    event: SyntheticEvent<HTMLImageElement>,
  ) => void;
  onItemPointerDown: (
    item: EditableImageCanvasItem,
    event: PointerEvent<HTMLImageElement>,
  ) => void;
  onSurfacePointerDown: () => void;
  regionSelectionActive: boolean;
  regionComments: EditableImageCanvasRegionComment[];
  renderRegionComment?: (
    comment: EditableImageCanvasRegionComment,
    item: EditableImageCanvasItem,
  ) => ReactNode;
  renderRegionToolbar?: (
    region: EditableImageCanvasRegion,
    item: EditableImageCanvasItem,
  ) => ReactNode;
  renderSelectionToolbar?: (item: EditableImageCanvasItem) => ReactNode;
  selectedRegion: EditableImageCanvasRegion | null;
  selectedItem: EditableImageCanvasItem | null;
  selectedItemId: string | null;
}) {
  const regionItem =
    selectedRegion === null
      ? null
      : (items.find((item) => {
          return item.id === selectedRegion.itemId;
        }) ?? null);
  const commentsWithItems = regionComments.flatMap((comment) => {
    const item = items.find((currentItem) => {
      return currentItem.id === comment.region.itemId;
    });
    return item ? [{ comment, item }] : [];
  });

  return (
    <div
      className="flex min-h-full min-w-full items-center justify-center p-16"
      onPointerDown={onSurfacePointerDown}
    >
      <div
        className="relative shrink-0 overflow-visible"
        data-testid={`${canvasTestId}-surface`}
        style={{
          height: DEFAULT_CANVAS_HEIGHT,
          width: DEFAULT_CANVAS_WIDTH,
        }}
      >
        {items.map((item) => {
          return (
            <CanvasItemView
              key={item.id}
              alt={alt}
              imageTestId={imageTestId}
              item={item}
              onImageLoad={onImageLoad}
              onPointerDown={onItemPointerDown}
              selectingRegion={regionSelectionActive}
              selected={item.id === selectedItemId}
            />
          );
        })}
        {selectedRegion && regionItem && (
          <RegionSelectionFrame item={regionItem} region={selectedRegion} />
        )}
        {renderRegionComment &&
          selectedRegion === null &&
          commentsWithItems.map(({ comment, item }) => {
            return (
              <RegionCommentAnchor
                key={comment.id}
                comment={comment}
                item={item}
                renderRegionComment={renderRegionComment}
              />
            );
          })}
        {selectedRegion &&
          regionItem &&
          renderRegionToolbar &&
          !regionSelectionActive && (
            <RegionToolbarAnchor
              item={regionItem}
              region={selectedRegion}
              renderRegionToolbar={renderRegionToolbar}
            />
          )}
        {selectedItem && renderSelectionToolbar && (
          <SelectionToolbarAnchor
            renderSelectionToolbar={renderSelectionToolbar}
            selectedItem={selectedItem}
          />
        )}
      </div>
    </div>
  );
}

function EditableImageTransformFrame({
  alt,
  canvasKey,
  canvasTestId,
  children,
  className,
  displayZoom,
  imageTestId,
  items,
  onImageLoad,
  onItemPointerDown,
  onKeyDown,
  onSurfacePointerDown,
  regionComments,
  regionSelectionActive,
  renderRegionComment,
  renderRegionToolbar,
  renderSelectionToolbar,
  selectedRegion,
  selectedItem,
  selectedItemId,
  setDisplayZoom,
  viewportKey,
}: EditableImageTransformFrameProps) {
  return (
    <TransformWrapper
      key={`${canvasKey}:${viewportKey}`}
      centerOnInit
      centerZoomedOut
      disablePadding
      doubleClick={{ disabled: true }}
      initialScale={1}
      limitToBounds={false}
      maxScale={IMAGE_LIGHTBOX_MAX_ZOOM}
      minScale={IMAGE_LIGHTBOX_MIN_ZOOM}
      autoAlignment={{ disabled: true }}
      onInit={(transformRef) => {
        setDisplayZoom(canvasKey, transformRef.state.scale);
      }}
      onTransform={(_transformRef, transformState) => {
        setDisplayZoom(canvasKey, transformState.scale);
      }}
      panning={{
        excluded: [
          "image-edit-canvas-item",
          "image-edit-floating-toolbar",
          "image-edit-region-comment",
          "image-edit-region-toolbar",
        ],
        velocityDisabled: true,
      }}
      pinch={{ allowPanning: false }}
      smooth={false}
      trackPadPanning={{ disabled: false }}
      wheel={{ activationKeys: ["Control"], wheelDisabled: true }}
    >
      {({ resetTransform, zoomIn, zoomOut }) => {
        const controls = controlsFromTransformState({
          displayZoom,
          resetTransform,
          setDisplayZoom,
          zoomIn,
          zoomKey: canvasKey,
          zoomOut,
        });

        return (
          <div
            className={cn(
              "relative h-full min-h-0 w-full flex-1 overflow-hidden bg-muted/30 outline-none",
              className,
            )}
            data-editable-image-canvas-root="true"
            data-testid={canvasTestId}
            onKeyDown={onKeyDown}
            tabIndex={0}
          >
            {children?.(controls)}
            <TransformComponent
              contentClass="min-h-full min-w-full"
              wrapperClass="h-full min-h-0 w-full cursor-grab active:cursor-grabbing"
              wrapperStyle={{
                height: "100%",
                touchAction: "none",
                width: "100%",
              }}
            >
              <EditableCanvasSurface
                alt={alt}
                canvasTestId={canvasTestId}
                imageTestId={imageTestId}
                items={items}
                onImageLoad={onImageLoad}
                onItemPointerDown={onItemPointerDown}
                onSurfacePointerDown={onSurfacePointerDown}
                regionComments={regionComments}
                regionSelectionActive={regionSelectionActive}
                renderRegionComment={renderRegionComment}
                renderRegionToolbar={renderRegionToolbar}
                renderSelectionToolbar={renderSelectionToolbar}
                selectedRegion={selectedRegion}
                selectedItem={selectedItem}
                selectedItemId={selectedItemId}
              />
            </TransformComponent>
          </div>
        );
      }}
    </TransformWrapper>
  );
}

export function EditableArtifactImageCanvas({
  alt,
  canvasKey,
  canvasTestId = "editable-image-canvas",
  children,
  className,
  imageTestId,
  renderRegionComment,
  renderRegionToolbar,
  renderSelectionToolbar,
  src,
  viewportKey,
}: EditableImageCanvasProps) {
  const canvasState = useEditableImageCanvasState(canvasKey, src);

  const handleImageLoad = (
    itemId: string,
    event: SyntheticEvent<HTMLImageElement>,
  ) => {
    const size = nextImageSize(event.currentTarget);
    if (size === null) {
      return;
    }
    canvasState.resizeItem({
      displayHeight: size.displayHeight,
      displayWidth: size.displayWidth,
      itemId,
      key: canvasKey,
      naturalHeight: size.naturalHeight,
      naturalWidth: size.naturalWidth,
      preserveDisplaySize: itemId.startsWith("image-edit-"),
      src,
    });
  };

  const handleItemPointerDown = (
    item: EditableImageCanvasItem,
    event: PointerEvent<HTMLImageElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusEditableImageCanvasRoot(event.currentTarget);

    if (canvasState.regionSelectionActive) {
      if (item.id !== canvasState.selectedItemId) {
        canvasState.clearRegionSelection(canvasKey);
        canvasState.selectItem(item.id);
        return;
      }

      startRegionSelectionDrag({
        clearRegionSelection: canvasState.clearRegionSelection,
        completeRegionSelection: canvasState.completeRegionSelection,
        event,
        item,
        key: canvasKey,
        selectItem: canvasState.selectItem,
        setRegionSelection: canvasState.setRegionSelection,
      });
      return;
    }

    if (canvasState.selectedRegion !== null) {
      cancelPendingRegionComment(canvasKey, canvasState, item.id);
      return;
    }

    canvasState.selectItem(item.id);
    startImageItemMoveDrag({
      displayZoom: canvasState.displayZoom,
      event,
      item,
      key: canvasKey,
      moveItem: canvasState.moveItem,
      src,
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    handleEditableImageCanvasKeyDown({ canvasKey, canvasState, event, src });
  };

  return (
    <EditableImageTransformFrame
      alt={alt}
      canvasKey={canvasKey}
      canvasTestId={canvasTestId}
      className={className}
      displayZoom={canvasState.displayZoom}
      imageTestId={imageTestId}
      items={canvasState.items}
      onImageLoad={handleImageLoad}
      onItemPointerDown={handleItemPointerDown}
      onKeyDown={handleKeyDown}
      onSurfacePointerDown={() => {
        clearEditableImageCanvasSurfaceSelection(canvasKey, canvasState);
      }}
      regionComments={canvasState.regionComments}
      regionSelectionActive={canvasState.regionSelectionActive}
      renderRegionComment={renderRegionComment}
      renderRegionToolbar={renderRegionToolbar}
      renderSelectionToolbar={renderSelectionToolbar}
      selectedRegion={canvasState.selectedRegion}
      selectedItem={canvasState.selectedItem}
      selectedItemId={canvasState.selectedItemId}
      setDisplayZoom={canvasState.setDisplayZoom}
      viewportKey={viewportKey}
    >
      {children}
    </EditableImageTransformFrame>
  );
}
