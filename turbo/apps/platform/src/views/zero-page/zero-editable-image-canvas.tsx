import type {
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  SyntheticEvent,
} from "react";
import {
  KeepScale,
  TransformComponent,
  TransformWrapper,
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
  copyEditableImageCanvasSelection$,
  createInitialEditableImageCanvasItem,
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  editableImageCanvasItemsByKey$,
  editableImageCanvasSelectedItemId$,
  type EditableImageCanvasItem,
  moveEditableImageCanvasItem$,
  pasteEditableImageCanvasSelection$,
  PRIMARY_IMAGE_ITEM_ID,
  resizeEditableImageCanvasItem$,
  selectEditableImageCanvasItem$,
} from "../../signals/zero-page/zero-editable-image-canvas.ts";
import type { ZoomableImageControls } from "./zero-zoomable-image-canvas.tsx";

const IMAGE_ZOOM_STEP = 0.15;
const MAX_INITIAL_IMAGE_EDGE = 900;
const TOOLBAR_OFFSET = 12;

type EditableImageCanvasProps = {
  alt: string;
  canvasKey: string;
  canvasTestId?: string;
  children?: (controls: ZoomableImageControls) => ReactNode;
  className?: string;
  imageTestId: string;
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
  renderSelectionToolbar?: (item: EditableImageCanvasItem) => ReactNode;
  selectedItem: EditableImageCanvasItem | null;
  selectedItemId: string | null;
  setDisplayZoom: (key: string, zoom: number) => void;
  viewportKey: string;
};

function nextImageSize(image: HTMLImageElement) {
  const naturalWidth = image.naturalWidth;
  const naturalHeight = image.naturalHeight;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }

  const scale = Math.min(
    1,
    MAX_INITIAL_IMAGE_EDGE / Math.max(naturalWidth, naturalHeight),
  );
  return {
    height: Math.round(naturalHeight * scale),
    width: Math.round(naturalWidth * scale),
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

function CanvasItemView({
  alt,
  imageTestId,
  item,
  onImageLoad,
  onPointerDown,
  selected,
}: CanvasItemViewProps) {
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
      className="image-edit-canvas-item absolute block max-w-none select-none touch-none cursor-move"
      style={{
        boxShadow: selected ? "0 0 0 3px rgba(255,255,255,0.88)" : undefined,
        height: "auto",
        left: item.x,
        outline: selected ? "4px solid rgb(59,130,246)" : undefined,
        pointerEvents: "auto",
        top: item.y,
        userSelect: "none",
        width: item.width,
        zIndex: item.zIndex,
      }}
    />
  );
}

function SelectionToolbarAnchor({
  renderSelectionToolbar,
  selectedItem,
}: {
  renderSelectionToolbar: (item: EditableImageCanvasItem) => ReactNode;
  selectedItem: EditableImageCanvasItem;
}) {
  return (
    <KeepScale
      className="image-edit-floating-toolbar absolute"
      style={{
        left: selectedItem.x + selectedItem.width / 2,
        top: selectedItem.y - TOOLBAR_OFFSET,
        zIndex: selectedItem.zIndex + 2,
      }}
    >
      <div className="-translate-x-1/2 -translate-y-full">
        {renderSelectionToolbar(selectedItem)}
      </div>
    </KeepScale>
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
  renderSelectionToolbar,
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
  renderSelectionToolbar?: (item: EditableImageCanvasItem) => ReactNode;
  selectedItem: EditableImageCanvasItem | null;
  selectedItemId: string | null;
}) {
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
              selected={item.id === selectedItemId}
            />
          );
        })}
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
  renderSelectionToolbar,
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
        excluded: ["image-edit-canvas-item", "image-edit-floating-toolbar"],
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
                renderSelectionToolbar={renderSelectionToolbar}
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
  renderSelectionToolbar,
  src,
  viewportKey,
}: EditableImageCanvasProps) {
  const itemsByKey = useGet(editableImageCanvasItemsByKey$);
  const selectedItemId = useGet(editableImageCanvasSelectedItemId$);
  const zoomByKey = useGet(zoomableImageCanvasZoomByKey$);
  const copySelection = useSet(copyEditableImageCanvasSelection$);
  const moveItem = useSet(moveEditableImageCanvasItem$);
  const pasteSelection = useSet(pasteEditableImageCanvasSelection$);
  const resizeItem = useSet(resizeEditableImageCanvasItem$);
  const selectItem = useSet(selectEditableImageCanvasItem$);
  const setDisplayZoom = useSet(setZoomableImageCanvasZoom$);
  const items = itemsByKey[canvasKey] ?? [
    createInitialEditableImageCanvasItem(src),
  ];
  const selectedItem =
    items.find((item) => {
      return item.id === selectedItemId;
    }) ?? null;
  const displayZoom = zoomByKey[canvasKey] ?? 1;

  const handleImageLoad = (
    itemId: string,
    event: SyntheticEvent<HTMLImageElement>,
  ) => {
    const size = nextImageSize(event.currentTarget);
    if (size === null) {
      return;
    }
    resizeItem({
      height: size.height,
      itemId,
      key: canvasKey,
      src,
      width: size.width,
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
    event.currentTarget
      .closest<HTMLElement>("[data-editable-image-canvas-root='true']")
      ?.focus();
    selectItem(item.id);

    const originClientX = event.clientX;
    const originClientY = event.clientY;
    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      moveItem({
        itemId: item.id,
        key: canvasKey,
        src,
        x: Math.round(
          item.x + (moveEvent.clientX - originClientX) / displayZoom,
        ),
        y: Math.round(
          item.y + (moveEvent.clientY - originClientY) / displayZoom,
        ),
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
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isEditableTextTarget(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();
    const shortcutPressed = event.metaKey || event.ctrlKey;
    if (shortcutPressed && key === "c" && selectedItem !== null) {
      event.preventDefault();
      copySelection(canvasKey, src);
      return;
    }
    if (shortcutPressed && key === "v") {
      event.preventDefault();
      pasteSelection(canvasKey, src);
    }
  };

  return (
    <EditableImageTransformFrame
      alt={alt}
      canvasKey={canvasKey}
      canvasTestId={canvasTestId}
      className={className}
      displayZoom={displayZoom}
      imageTestId={imageTestId}
      items={items}
      onImageLoad={handleImageLoad}
      onItemPointerDown={handleItemPointerDown}
      onKeyDown={handleKeyDown}
      onSurfacePointerDown={() => {
        selectItem(null);
      }}
      renderSelectionToolbar={renderSelectionToolbar}
      selectedItem={selectedItem}
      selectedItemId={selectedItemId}
      setDisplayZoom={setDisplayZoom}
      viewportKey={viewportKey}
    >
      {children}
    </EditableImageTransformFrame>
  );
}
