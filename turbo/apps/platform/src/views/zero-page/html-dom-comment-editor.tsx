import type { KeyboardEvent, PointerEvent } from "react";
import {
  IconArrowUp,
  IconColorPicker,
  IconLoader2,
  IconMessageCircle,
  IconSend,
  IconTrash,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import { detach, Reason, tapError } from "../../signals/utils.ts";
import {
  addHtmlDomComment$,
  applyHtmlDomColorStyle$,
  applyHtmlDomStyleEdits$,
  beginEditingCurrentHtmlDomComment$,
  bindHtmlDomCommentFrame$,
  deleteHtmlDomComment$,
  discardHtmlDomComments$,
  focusHtmlDomComment$,
  htmlDomCommentEditorModel$,
  sendHtmlDomEditRequest$,
  setHtmlDomColorPopoverOffset$,
  setHtmlDomCommentIframeRef$,
  setHtmlDomCommentStageRef$,
  setHtmlDomCommentTextareaRef$,
  setHtmlDomCommentText$,
  toggleHtmlDomColorPanel$,
  toggleHtmlDomCommentsOpen$,
  type HtmlDomStyleProperty,
  type HtmlDomCommentEditorModel,
} from "../../signals/zero-page/html-dom-comment-editor.ts";
import type {
  HtmlDomEditComment,
  HtmlDomEditDraft,
  HtmlDomEditPayload,
} from "./html-dom-edit-types.ts";

interface HtmlDomCommentEditorProps {
  readonly filename: string;
  readonly onApplyEditDraft?: (draft: HtmlDomEditDraft) => Promise<void>;
  readonly onApplyStyleEdits?: (html: string) => Promise<void>;
  readonly onClose: () => void;
  readonly onEditRequestFailed?: () => void;
  readonly onEditRequestStarted?: () => void;
  readonly onSubmitEditRequest?: (payload: HtmlDomEditPayload) => Promise<void>;
  readonly pageSignal: AbortSignal;
  readonly status?: "working";
  readonly url: string;
}

function HtmlDomCommentStage({
  filename,
  model,
  onApplyEditDraft,
  onApplyStyleEdits,
  onEditRequestFailed,
  onEditRequestStarted,
  onSubmitEditRequest,
  pageSignal,
  status,
  url,
}: {
  readonly filename: string;
  readonly model: HtmlDomCommentEditorModel;
  readonly onApplyEditDraft?: (draft: HtmlDomEditDraft) => Promise<void>;
  readonly onApplyStyleEdits?: (html: string) => Promise<void>;
  readonly onEditRequestFailed?: () => void;
  readonly onEditRequestStarted?: () => void;
  readonly onSubmitEditRequest?: (payload: HtmlDomEditPayload) => Promise<void>;
  readonly pageSignal: AbortSignal;
  readonly status?: "working";
  readonly url: string;
}) {
  const bindFrame = useSet(bindHtmlDomCommentFrame$);
  const setIframeRef = useSet(setHtmlDomCommentIframeRef$);
  const setStageRef = useSet(setHtmlDomCommentStageRef$);
  const loadState = model.loadState;
  const working = status === "working" || model.submitting;

  return (
    <div
      ref={setStageRef}
      className="relative min-h-[260px] flex-1 overflow-hidden bg-muted/20"
      data-html-dom-comment-url={url}
    >
      {loadState.status === "loading" && (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <IconLoader2 size={16} className="animate-spin" />
          Loading page
        </div>
      )}
      {loadState.status === "error" && (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {loadState.message}
        </div>
      )}
      {loadState.status === "ready" && (
        <iframe
          ref={setIframeRef}
          srcDoc={loadState.html}
          title={`${filename} comment preview`}
          sandbox="allow-same-origin allow-scripts"
          className="block h-full w-full border-0 bg-background"
          data-testid="html-dom-comment-frame"
          onLoad={(event) => {
            bindFrame(event.currentTarget);
          }}
        />
      )}
      {!working && <HtmlDomCommentPopover model={model} />}
      {!working && <HtmlDomFloatingColorPopover model={model} />}
      <HtmlDomCommentToolbar
        disabled={working}
        model={model}
        onApplyEditDraft={onApplyEditDraft}
        onApplyStyleEdits={onApplyStyleEdits}
        onEditRequestFailed={onEditRequestFailed}
        onEditRequestStarted={onEditRequestStarted}
        onSubmitEditRequest={onSubmitEditRequest}
        pageSignal={pageSignal}
      />
    </div>
  );
}

function HtmlDomCommentsList({
  comments,
}: {
  readonly comments: readonly HtmlDomEditComment[];
}) {
  const deleteComment = useSet(deleteHtmlDomComment$);
  const focusComment = useSet(focusHtmlDomComment$);

  return (
    <div
      className="absolute bottom-full left-0 mb-3 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border/80 bg-background/98 p-2 shadow-2xl ring-1 ring-black/5 backdrop-blur"
      data-testid="html-dom-comments-list"
    >
      <div className="flex items-center justify-between px-2 pb-2 pt-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Comments
        </div>
        <div className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          {comments.length}
        </div>
      </div>
      {comments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/80 bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
          No comments yet
        </div>
      ) : (
        <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
          {comments.map((comment) => {
            const focusCurrentComment = () => {
              focusComment(comment.id);
            };
            return (
              <div
                key={comment.id}
                role="button"
                tabIndex={0}
                className="group/comment relative cursor-pointer rounded-lg border border-transparent bg-muted/35 px-3 py-2.5 pr-10 text-left transition-colors hover:border-blue-200 hover:bg-blue-50/70 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                onClick={focusCurrentComment}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  focusCurrentComment();
                }}
              >
                <div className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
                  {comment.comment}
                </div>
                <button
                  type="button"
                  aria-label="Delete comment"
                  className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-blue-200 bg-background text-blue-600 opacity-0 shadow-sm transition-opacity hover:bg-blue-600 hover:text-white focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 group-hover/comment:opacity-100"
                  data-testid="html-dom-comments-list-delete"
                  onKeyDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteComment(comment.id);
                  }}
                >
                  <IconTrash size={14} stroke={2} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HtmlDomCommentToolbar({
  disabled,
  model,
  onApplyEditDraft,
  onApplyStyleEdits,
  onEditRequestFailed,
  onEditRequestStarted,
  onSubmitEditRequest,
  pageSignal,
}: {
  readonly disabled: boolean;
  readonly model: HtmlDomCommentEditorModel;
  readonly onApplyEditDraft?: (draft: HtmlDomEditDraft) => Promise<void>;
  readonly onApplyStyleEdits?: (html: string) => Promise<void>;
  readonly onEditRequestFailed?: () => void;
  readonly onEditRequestStarted?: () => void;
  readonly onSubmitEditRequest?: (payload: HtmlDomEditPayload) => Promise<void>;
  readonly pageSignal: AbortSignal;
}) {
  const applyStyleEdits = useSet(applyHtmlDomStyleEdits$);
  const discardComments = useSet(discardHtmlDomComments$);
  const sendEditRequest = useSet(sendHtmlDomEditRequest$);
  const toggleCommentsOpen = useSet(toggleHtmlDomCommentsOpen$);
  const primaryAction = model.comments.length > 0 ? "send" : "apply";
  const canRunPrimaryAction =
    primaryAction === "send" ? model.canSend : model.canApplyStyleEdits;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div className="relative pointer-events-auto">
        {!disabled && model.commentsOpen && (
          <HtmlDomCommentsList comments={model.comments} />
        )}
        <div
          className="flex items-center gap-2 rounded-full border border-border/70 bg-background/95 px-2 py-2 shadow-xl backdrop-blur"
          data-testid="html-dom-comment-toolbar"
        >
          <button
            type="button"
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            onClick={toggleCommentsOpen}
            aria-label="Show comments"
            data-testid="html-dom-toolbar-comments"
          >
            <IconMessageCircle size={18} stroke={1.9} />
            {model.comments.length > 0 && (
              <span
                className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold leading-none text-white"
                data-testid="html-dom-toolbar-comments-count"
              >
                {model.comments.length}
              </span>
            )}
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled}
            onClick={discardComments}
            data-testid="html-dom-toolbar-discard"
          >
            Discard
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={disabled || !canRunPrimaryAction}
            onClick={() => {
              if (primaryAction === "apply") {
                detach(
                  applyStyleEdits(
                    {
                      onApplied: onApplyStyleEdits,
                      onFailed: onEditRequestFailed,
                      onStarted: onEditRequestStarted,
                    },
                    pageSignal,
                  ),
                  Reason.DomCallback,
                  "applyHtmlDomStyleEdits",
                );
                return;
              }
              detach(
                sendEditRequest(
                  {
                    onFailed: onEditRequestFailed,
                    onGenerated: onApplyEditDraft,
                    onPrepared: onSubmitEditRequest,
                    onStarted: onEditRequestStarted,
                  },
                  pageSignal,
                ),
                Reason.DomCallback,
                "submitHtmlDomEditRequest",
              );
            }}
            data-testid="html-dom-toolbar-send"
          >
            {model.submitting ? (
              <IconLoader2 size={16} className="animate-spin" />
            ) : (
              <IconSend size={16} stroke={1.9} />
            )}
            {model.submitting || disabled
              ? "Working"
              : primaryAction === "apply"
                ? "Apply"
                : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function colorControlLabel(property: HtmlDomStyleProperty): string {
  return property === "color" ? "Text" : "Background";
}

function colorControlValue({
  model,
  property,
}: {
  readonly model: HtmlDomCommentEditorModel;
  readonly property: HtmlDomStyleProperty;
}): string {
  return property === "color"
    ? model.selectedStyle.color
    : model.selectedStyle.backgroundColor;
}

interface RgbColor {
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

interface HsvColor {
  readonly hue: number;
  readonly saturation: number;
  readonly value: number;
}

interface BrowserEyeDropper {
  readonly open: () => Promise<{ readonly sRGBHex: string }>;
}

type BrowserEyeDropperConstructor = new () => BrowserEyeDropper;

type EyeDropperGlobal = typeof globalThis & {
  readonly EyeDropper?: BrowserEyeDropperConstructor;
};

function browserEyeDropperConstructor(): BrowserEyeDropperConstructor | null {
  return (globalThis as EyeDropperGlobal).EyeDropper ?? null;
}

function clampColorChannel(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex: string): RgbColor {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "111827";
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(color: RgbColor): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) => {
      return clampColorChannel(channel).toString(16).padStart(2, "0");
    })
    .join("")
    .toUpperCase()}`;
}

function rgbToHsv(color: RgbColor): HsvColor {
  const red = color.red / 255;
  const green = color.green / 255;
  const blue = color.blue / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta !== 0) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }
    hue *= 60;
  }

  return {
    hue: hue < 0 ? hue + 360 : hue,
    saturation: max === 0 ? 0 : delta / max,
    value: max,
  };
}

function hsvToRgb(color: HsvColor): RgbColor {
  const chroma = color.value * color.saturation;
  const hueSegment = color.hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1));
  const match = color.value - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hueSegment >= 0 && hueSegment < 1) {
    red = chroma;
    green = secondary;
  } else if (hueSegment < 2) {
    red = secondary;
    green = chroma;
  } else if (hueSegment < 3) {
    green = chroma;
    blue = secondary;
  } else if (hueSegment < 4) {
    green = secondary;
    blue = chroma;
  } else if (hueSegment < 5) {
    red = secondary;
    blue = chroma;
  } else {
    red = chroma;
    blue = secondary;
  }

  return {
    red: clampColorChannel((red + match) * 255),
    green: clampColorChannel((green + match) * 255),
    blue: clampColorChannel((blue + match) * 255),
  };
}

function HtmlDomColorControl({
  active,
  model,
  onClick,
  property,
}: {
  readonly active: boolean;
  readonly model: HtmlDomCommentEditorModel;
  readonly onClick: () => void;
  readonly property: HtmlDomStyleProperty;
}) {
  const value = colorControlValue({ model, property });

  return (
    <button
      type="button"
      aria-expanded={active}
      aria-label={`Open ${property === "color" ? "text" : "background"} color panel`}
      className={`flex h-16 w-[168px] shrink-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-blue-500/30 ${
        active ? "bg-muted" : "bg-muted/55 hover:bg-muted/80"
      }`}
      data-testid={`html-dom-color-control-${property}`}
      onClick={onClick}
    >
      <span className="min-w-0">
        <span className="block text-[11px] font-medium leading-3 text-muted-foreground">
          {colorControlLabel(property)}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[12px] font-medium text-foreground">
          {value.toLowerCase()}
        </span>
      </span>
      <span
        className={`h-7 w-7 shrink-0 rounded-full border shadow-sm transition ${
          active
            ? "border-foreground ring-2 ring-foreground/20 ring-offset-1"
            : "border-border/80"
        }`}
        style={{ backgroundColor: value }}
      />
    </button>
  );
}

function HtmlDomColorField({
  activeProperty,
  hsv,
  hueHex,
  onPick,
}: {
  readonly activeProperty: HtmlDomStyleProperty;
  readonly hsv: HsvColor;
  readonly hueHex: string;
  readonly onPick: (hsv: HsvColor) => void;
}) {
  const handlePick = (event: PointerEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    onPick({
      hue: hsv.hue,
      saturation: Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width),
      ),
      value:
        1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    });
  };

  return (
    <button
      type="button"
      aria-label={`Pick ${activeProperty === "backgroundColor" ? "background" : "text"} color saturation and brightness`}
      className="relative block h-28 w-full cursor-crosshair border-0 p-0 focus:outline-none focus:ring-2 focus:ring-blue-500"
      data-testid="html-dom-color-field"
      style={{ backgroundColor: hueHex }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        handlePick(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons !== 1) {
          return;
        }
        handlePick(event);
      }}
    >
      <span className="absolute inset-0 bg-gradient-to-r from-white to-transparent" />
      <span className="absolute inset-0 bg-gradient-to-t from-black to-transparent" />
      <span
        className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.25)]"
        style={{
          left: `${hsv.saturation * 100}%`,
          top: `${(1 - hsv.value) * 100}%`,
        }}
      />
    </button>
  );
}

function HtmlDomHueSlider({
  hsv,
  hueHex,
  onChange,
}: {
  readonly hsv: HsvColor;
  readonly hueHex: string;
  readonly onChange: (hue: number) => void;
}) {
  const handlePick = (event: PointerEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const percent = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    );
    onChange(percent * 360);
  };

  return (
    <button
      type="button"
      aria-label="Hue"
      className="relative h-7 min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 focus:outline-none focus:ring-2 focus:ring-blue-500/25"
      data-testid="html-dom-color-hue-slider"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        handlePick(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons !== 1) {
          return;
        }
        handlePick(event);
      }}
    >
      <div
        className="absolute left-0 right-0 top-1/2 h-3 -translate-y-1/2 rounded-full shadow-inner"
        style={{
          background:
            "linear-gradient(90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
        }}
      />
      <span
        className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgba(15,23,42,0.25),0_2px_5px_rgba(15,23,42,0.18)]"
        style={{
          left: `${(hsv.hue / 360) * 100}%`,
          backgroundColor: hueHex,
        }}
      />
    </button>
  );
}

function HtmlDomRgbInputs({
  onChange,
  rgb,
}: {
  readonly onChange: (channel: keyof RgbColor, value: string) => void;
  readonly rgb: RgbColor;
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {(
        [
          ["red", "R", rgb.red],
          ["green", "G", rgb.green],
          ["blue", "B", rgb.blue],
        ] as const
      ).map(([channel, label, value]) => {
        return (
          <label
            key={channel}
            className="flex h-8 min-w-0 items-center rounded-lg border border-border/70 bg-muted/45 px-2 focus-within:border-blue-500 focus-within:bg-background focus-within:ring-2 focus-within:ring-blue-500/15"
          >
            <span className="w-4 text-[11px] font-semibold text-muted-foreground">
              {label}
            </span>
            <input
              type="number"
              min={0}
              max={255}
              value={value}
              aria-label={label}
              className="h-full min-w-0 flex-1 border-0 bg-transparent px-1 text-right text-sm font-medium tabular-nums text-foreground outline-none"
              onInput={(event) => {
                onChange(channel, event.currentTarget.value);
              }}
              onChange={(event) => {
                onChange(channel, event.currentTarget.value);
              }}
            />
          </label>
        );
      })}
    </div>
  );
}

function HtmlDomEyeDropperButton({
  onPick,
}: {
  readonly onPick: (value: string) => void;
}) {
  const EyeDropper = browserEyeDropperConstructor();
  if (!EyeDropper) {
    return null;
  }

  const pickColor = async (): Promise<void> => {
    const result = await tapError(new EyeDropper().open(), () => {
      return undefined;
    });
    if (result) {
      onPick(result.sRGBHex.toUpperCase());
    }
  };

  return (
    <button
      type="button"
      aria-label="Pick color from screen"
      title="Pick color from screen"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/45 text-muted-foreground transition hover:bg-muted/80 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/25"
      data-testid="html-dom-color-eyedropper"
      onClick={() => {
        detach(pickColor(), Reason.DomCallback, "pickHtmlDomColor");
      }}
    >
      <IconColorPicker size={15} stroke={1.9} />
    </button>
  );
}

function numericDragValue(value: string | undefined): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function HtmlDomColorPopoverDragHandle({
  model,
}: {
  readonly model: HtmlDomCommentEditorModel;
}) {
  const setOffset = useSet(setHtmlDomColorPopoverOffset$);

  return (
    <button
      type="button"
      aria-label="Drag color panel"
      className="flex h-4 w-full cursor-grab items-center justify-center border-0 bg-transparent p-0 active:cursor-grabbing"
      data-testid="html-dom-color-popover-drag-handle"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.currentTarget.dataset.dragStartX = String(event.clientX);
        event.currentTarget.dataset.dragStartY = String(event.clientY);
        event.currentTarget.dataset.dragStartLeft = String(
          model.colorPopoverOffset.left,
        );
        event.currentTarget.dataset.dragStartTop = String(
          model.colorPopoverOffset.top,
        );
      }}
      onPointerMove={(event) => {
        if (
          event.buttons !== 1 ||
          event.currentTarget.dataset.dragStartX === undefined
        ) {
          return;
        }
        setOffset({
          left:
            numericDragValue(event.currentTarget.dataset.dragStartLeft) +
            event.clientX -
            numericDragValue(event.currentTarget.dataset.dragStartX),
          top:
            numericDragValue(event.currentTarget.dataset.dragStartTop) +
            event.clientY -
            numericDragValue(event.currentTarget.dataset.dragStartY),
        });
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        delete event.currentTarget.dataset.dragStartX;
      }}
    >
      <span className="h-1 w-10 rounded-full bg-muted-foreground/25" />
    </button>
  );
}

function HtmlDomColorPopover({
  activeProperty,
  model,
}: {
  readonly activeProperty: HtmlDomStyleProperty;
  readonly model: HtmlDomCommentEditorModel;
}) {
  const applyColorStyle = useSet(applyHtmlDomColorStyle$);
  const activeValue = colorControlValue({
    model,
    property: activeProperty,
  }).toUpperCase();
  const rgb = hexToRgb(activeValue);
  const hsv = rgbToHsv(rgb);
  const hueHex = rgbToHex(
    hsvToRgb({
      hue: hsv.hue,
      saturation: 1,
      value: 1,
    }),
  );
  const applyHex = (value: string) => {
    applyColorStyle({ property: activeProperty, value });
  };
  const handleHueChange = (hue: number): void => {
    applyHex(
      rgbToHex(
        hsvToRgb({
          hue,
          saturation: hsv.saturation,
          value: hsv.value,
        }),
      ),
    );
  };
  const handleRgbChange = (channel: keyof RgbColor, value: string): void => {
    applyHex(
      rgbToHex({
        ...rgb,
        [channel]: clampColorChannel(Number(value)),
      }),
    );
  };

  return (
    <div
      className="overflow-hidden rounded-xl border border-border/70 bg-background/98 shadow-lg"
      data-testid="html-dom-color-popover"
    >
      <HtmlDomColorPopoverDragHandle model={model} />
      <HtmlDomColorField
        activeProperty={activeProperty}
        hsv={hsv}
        hueHex={hueHex}
        onPick={(nextHsv) => {
          applyHex(rgbToHex(hsvToRgb(nextHsv)));
        }}
      />
      <div className="space-y-2 p-2.5">
        <div className="flex items-center gap-2">
          <HtmlDomEyeDropperButton onPick={applyHex} />
          <div
            className="h-7 w-7 shrink-0 rounded-full border border-border/80 shadow-sm"
            style={{ backgroundColor: activeValue }}
          />
          <HtmlDomHueSlider
            hsv={hsv}
            hueHex={hueHex}
            onChange={handleHueChange}
          />
        </div>
        <HtmlDomRgbInputs rgb={rgb} onChange={handleRgbChange} />
      </div>
    </div>
  );
}

function HtmlDomColorControls({
  model,
}: {
  readonly model: HtmlDomCommentEditorModel;
}) {
  const toggleColorPanel = useSet(toggleHtmlDomColorPanel$);
  const activeProperty = model.activeColorPanelProperty;
  if (model.editableStyleProperties.length === 0) {
    return null;
  }

  return (
    <div className="mt-2" data-testid="html-dom-color-controls">
      <div className="flex flex-wrap gap-1.5">
        {model.editableStyleProperties.map((property) => {
          const active = activeProperty === property;
          return (
            <HtmlDomColorControl
              key={property}
              active={active}
              model={model}
              property={property}
              onClick={() => {
                toggleColorPanel(property);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function HtmlDomFloatingColorPopover({
  model,
}: {
  readonly model: HtmlDomCommentEditorModel;
}) {
  const activeProperty = model.activeColorPanelProperty;
  if (
    activeProperty === null ||
    !model.editableStyleProperties.includes(activeProperty) ||
    !model.commentPopoverAnchor
  ) {
    return null;
  }

  return (
    <div
      className="absolute z-40 w-[min(280px,calc(100%-24px))] -translate-x-1/2"
      style={{
        left: model.commentPopoverAnchor.left + model.colorPopoverOffset.left,
        top: Math.max(
          12,
          model.commentPopoverAnchor.top + 104 + model.colorPopoverOffset.top,
        ),
      }}
      data-testid="html-dom-floating-color-popover"
    >
      <HtmlDomColorPopover activeProperty={activeProperty} model={model} />
    </div>
  );
}

function HtmlDomCommentPopover({
  model,
}: {
  readonly model: HtmlDomCommentEditorModel;
}) {
  const addComment = useSet(addHtmlDomComment$);
  const beginEditingCurrentComment = useSet(beginEditingCurrentHtmlDomComment$);
  const setCommentText = useSet(setHtmlDomCommentText$);
  const setTextAreaRef = useSet(setHtmlDomCommentTextareaRef$);
  const isEditingCurrentComment =
    model.editingCommentId !== null &&
    model.currentComment?.id === model.editingCommentId;
  const isShowingExistingComment =
    model.currentComment !== null && !isEditingCurrentComment;
  const visibleCommentText = isEditingCurrentComment
    ? model.commentText
    : (model.currentComment?.comment ?? model.commentText);

  if (!model.commentPopoverAnchor) {
    return null;
  }

  const handleTextAreaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }

    event.preventDefault();
    addComment();
  };

  return (
    <div
      className="absolute z-30 w-[min(380px,calc(100%-24px))] -translate-x-1/2 rounded-[28px] border border-border/60 bg-background p-2.5 shadow-lg"
      style={{
        left: model.commentPopoverAnchor.left,
        top: model.commentPopoverAnchor.top,
      }}
      data-testid="html-dom-comment-popover"
    >
      <div className="flex items-end gap-2">
        <textarea
          key={model.popoverTextAreaKey}
          ref={setTextAreaRef}
          rows={1}
          value={visibleCommentText}
          readOnly={isShowingExistingComment}
          onClick={() => {
            if (isShowingExistingComment) {
              beginEditingCurrentComment();
            }
          }}
          onFocus={() => {
            if (isShowingExistingComment) {
              beginEditingCurrentComment();
            }
          }}
          onChange={(event) => {
            if (isShowingExistingComment) {
              return;
            }
            setCommentText(event.currentTarget.value);
          }}
          onKeyDown={handleTextAreaKeyDown}
          placeholder="Describe the change you want"
          className="max-h-32 min-h-9 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 text-sm leading-5 outline-none [field-sizing:content] placeholder:text-muted-foreground"
          data-testid="html-dom-comment-textarea"
        />
        <button
          type="button"
          disabled={!model.canAddComment}
          onClick={addComment}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
          data-testid="html-dom-comment-add"
          aria-label="Add comment"
        >
          <IconArrowUp size={19} stroke={2.2} />
        </button>
      </div>
      <HtmlDomColorControls model={model} />
    </div>
  );
}

export function HtmlDomCommentEditor({
  filename,
  onApplyEditDraft,
  onApplyStyleEdits,
  onEditRequestFailed,
  onEditRequestStarted,
  onSubmitEditRequest,
  pageSignal,
  status,
  url,
}: HtmlDomCommentEditorProps) {
  const model = useGet(htmlDomCommentEditorModel$);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="html-dom-comment-editor"
    >
      <HtmlDomCommentStage
        filename={filename}
        model={model}
        onApplyEditDraft={onApplyEditDraft}
        onEditRequestFailed={onEditRequestFailed}
        onEditRequestStarted={onEditRequestStarted}
        onSubmitEditRequest={onSubmitEditRequest}
        pageSignal={pageSignal}
        status={status}
        url={url}
        onApplyStyleEdits={onApplyStyleEdits}
      />
    </div>
  );
}
