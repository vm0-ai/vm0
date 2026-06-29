import type { KeyboardEvent, ReactNode } from "react";
import {
  IconArrowUp,
  IconChevronDown,
  IconChevronUp,
  IconLoader2,
  IconMessageCircle,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import { Input } from "@vm0/ui";
import { detach, Reason } from "../../signals/utils.ts";
import {
  addHtmlDomComment$,
  beginEditingCurrentHtmlDomComment$,
  bindHtmlDomCommentFrame$,
  closeHtmlDomCommentPopover$,
  deleteHtmlDomComment$,
  discardHtmlDomComments$,
  focusHtmlDomComment$,
  htmlDomCommentEditorModel$,
  sendHtmlDomEditRequest$,
  setHtmlDomCommentIframeRef$,
  setHtmlDomCommentStageRef$,
  setHtmlDomCommentTextareaRef$,
  setHtmlDomCommentText$,
  setHtmlDomStyleEditProperty$,
  toggleHtmlDomCommentsOpen$,
  type HtmlDomCommentEditorModel,
  type HtmlDomSelectedStyle,
  type HtmlDomStyleEditProperty,
} from "../../signals/zero-page/html-dom-comment-editor.ts";
import type {
  HtmlDomEditComment,
  HtmlDomEditDraft,
  HtmlDomEditPayload,
} from "./html-dom-edit-types.ts";

interface HtmlDomCommentEditorProps {
  readonly filename: string;
  readonly onApplyEditDraft?: (draft: HtmlDomEditDraft) => Promise<void>;
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
      <HtmlDomCommentToolbar
        disabled={working}
        model={model}
        onApplyEditDraft={onApplyEditDraft}
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
  onEditRequestFailed,
  onEditRequestStarted,
  onSubmitEditRequest,
  pageSignal,
}: {
  readonly disabled: boolean;
  readonly model: HtmlDomCommentEditorModel;
  readonly onApplyEditDraft?: (draft: HtmlDomEditDraft) => Promise<void>;
  readonly onEditRequestFailed?: () => void;
  readonly onEditRequestStarted?: () => void;
  readonly onSubmitEditRequest?: (payload: HtmlDomEditPayload) => Promise<void>;
  readonly pageSignal: AbortSignal;
}) {
  const discardComments = useSet(discardHtmlDomComments$);
  const sendEditRequest = useSet(sendHtmlDomEditRequest$);
  const toggleCommentsOpen = useSet(toggleHtmlDomCommentsOpen$);

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
            disabled={disabled || !model.canSend}
            onClick={() => {
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
            {model.submitting || disabled ? "Working" : "Send"}
          </button>
        </div>
      </div>
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
  const closePopover = useSet(closeHtmlDomCommentPopover$);
  const setCommentText = useSet(setHtmlDomCommentText$);
  const setTextAreaRef = useSet(setHtmlDomCommentTextareaRef$);
  const isEditingCurrentComment =
    model.editingCommentId !== null &&
    model.currentComment?.id === model.editingCommentId;
  const isShowingExistingComment =
    model.currentComment !== null && !isEditingCurrentComment;
  const showStyleControls =
    model.selectedStyle !== null && !isShowingExistingComment;
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
      className="absolute z-30 flex w-[min(430px,calc(100%-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-[20px] border border-border/60 bg-background shadow-lg"
      style={{
        left: model.commentPopoverAnchor.left,
        top: model.commentPopoverAnchor.top,
      }}
      data-testid="html-dom-comment-popover"
    >
      <div className="flex items-start gap-2 p-3">
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
          className="max-h-32 min-h-20 min-w-0 flex-1 resize-none rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm leading-5 text-foreground outline-none transition-colors [field-sizing:content] placeholder:text-muted-foreground focus:border-primary focus:ring-[3px] focus:ring-primary/10"
          data-testid="html-dom-comment-textarea"
        />
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            disabled={!model.canAddComment}
            onClick={addComment}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-45"
            data-testid="html-dom-comment-add"
            aria-label="Add comment"
          >
            <IconArrowUp size={19} stroke={2.2} />
          </button>
          <button
            type="button"
            onClick={closePopover}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
            aria-label="Close editor"
            data-testid="html-dom-comment-close"
          >
            <IconX size={17} stroke={1.8} />
          </button>
        </div>
      </div>
      {showStyleControls && (
        <HtmlDomStyleInspector selectedStyle={model.selectedStyle} />
      )}
    </div>
  );
}

function HtmlDomStyleInspector({
  selectedStyle,
}: {
  readonly selectedStyle: HtmlDomSelectedStyle;
}) {
  return (
    <div className="border-t border-border/60">
      <div className="flex h-11 items-end gap-6 px-4" role="tablist">
        <span
          role="tab"
          aria-selected="true"
          className="h-11 border-b-2 border-foreground px-0 text-sm font-medium text-foreground"
        >
          Style
        </span>
        <span
          role="tab"
          aria-selected="false"
          aria-disabled="true"
          className="h-11 px-0 text-sm font-medium text-muted-foreground opacity-70"
        >
          Layout
        </span>
      </div>
      <StyleSection title="Colors" open>
        <div className="grid gap-3 sm:grid-cols-2">
          <ColorField
            label="Text color"
            property="color"
            value={selectedStyle.color}
            testId="html-dom-style-text-color"
          />
          <ColorField
            label="Background"
            property="backgroundColor"
            value={selectedStyle.backgroundColor}
            testId="html-dom-style-background-color"
          />
        </div>
      </StyleSection>
      <StyleSection title="Typography" />
      <StyleSection title="Border" open>
        <ColorField
          label="Border color"
          property="borderColor"
          value={selectedStyle.borderColor}
          testId="html-dom-style-border-color"
        />
      </StyleSection>
      <StyleSection title="Display" />
    </div>
  );
}

function StyleSection({
  children,
  open = false,
  title,
}: {
  readonly children?: ReactNode;
  readonly open?: boolean;
  readonly title: string;
}) {
  return (
    <section className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        className="flex h-11 w-full items-center justify-between px-4 text-left text-sm font-medium text-foreground transition-colors hover:bg-gray-50"
        aria-expanded={open}
        disabled={!open}
      >
        {title}
        {open ? (
          <IconChevronUp
            size={17}
            stroke={1.8}
            className="text-muted-foreground"
          />
        ) : (
          <IconChevronDown
            size={17}
            stroke={1.8}
            className="text-muted-foreground"
          />
        )}
      </button>
      {open && children && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

function ColorField({
  label,
  property,
  testId,
  value,
}: {
  readonly label: string;
  readonly property: HtmlDomStyleEditProperty;
  readonly testId: string;
  readonly value: string;
}) {
  const setStyleEditProperty = useSet(setHtmlDomStyleEditProperty$);

  const commitColor = (nextValue: string) => {
    setStyleEditProperty({ property, value: nextValue });
  };

  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="relative">
        <span
          className="pointer-events-none absolute left-2 top-1/2 h-5 w-5 -translate-y-1/2 rounded-md border border-border/70"
          style={{ backgroundColor: value }}
          aria-hidden="true"
        />
        <input
          type="color"
          value={value}
          aria-label={`${label} picker`}
          onChange={(event) => {
            commitColor(event.currentTarget.value);
          }}
          className="absolute left-2 top-1/2 h-5 w-5 -translate-y-1/2 cursor-pointer opacity-0"
        />
        <Input
          value={value}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          onChange={(event) => {
            commitColor(event.currentTarget.value);
          }}
          className="h-9 pl-10 font-mono lowercase"
          maxLength={7}
          spellCheck={false}
          data-testid={testId}
        />
      </div>
    </label>
  );
}

export function HtmlDomCommentEditor({
  filename,
  onApplyEditDraft,
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
      />
    </div>
  );
}
