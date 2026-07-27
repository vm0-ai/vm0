import {
  IconCircleCheck,
  IconExternalLink,
  IconLoader2,
  IconPaperclip,
  IconPencil,
  IconPlayerPlay,
  IconRoute,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import type {
  ZeroMailAttachment,
  ZeroMailDraft,
  ZeroMailInlineImage,
} from "@vm0/api-contracts/contracts/zero-mail";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { Button } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { CSSProperties, ReactNode } from "react";

import type { MailDraftSignals } from "../../signals/chat-page/mail-draft.ts";
import { classifyChatAttachment } from "../../signals/chat-page/parse-body-blocks.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  openImageLightbox$,
  openVideoLightbox$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import { closeMailDraftSidebar$ } from "../../signals/zero-page/mail-draft-sidebar.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  isTextPreviewKind,
  type TextPreviewComputed,
} from "../../signals/text-preview.ts";
import {
  FileAttachmentChip,
  PreviewableAudioAttachmentChip,
  PreviewableFileAttachmentChip,
} from "./zero-attachment-chips.tsx";
import { useGmailReconnect } from "./use-gmail-reconnect.ts";

interface MailDraftSidebarProps {
  readonly signals: MailDraftSignals;
  // Overrides the legacy search-param close when the thread-owned sidebar
  // hosts the draft.
  readonly onClose?: () => void;
}

function SidebarCloseButton({ close }: { readonly close: () => void }) {
  return (
    <button
      type="button"
      onClick={close}
      aria-label="Close email details"
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      <IconX size={16} />
    </button>
  );
}

function MailDraftSidebarSkeleton({ close }: { readonly close: () => void }) {
  return (
    <aside
      aria-busy="true"
      aria-label="Loading email details"
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
    >
      <div className="min-h-0 flex-1 overflow-hidden px-5 py-5 animate-pulse">
        <div className="border-b border-border/60 pb-5">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="h-6 w-52 max-w-full rounded bg-muted/60" />
              <div className="relative top-0.5 h-5 w-12 shrink-0 rounded-full bg-muted/50" />
            </div>
            <SidebarCloseButton close={close} />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <div className="size-9 shrink-0 rounded-full bg-muted/60" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-44 max-w-full rounded bg-muted/60" />
              <div className="h-3 w-64 max-w-full rounded bg-muted/50" />
            </div>
          </div>
        </div>
        <div className="space-y-2 py-5">
          <div className="h-4 w-full rounded bg-muted/60" />
          <div className="h-4 w-5/6 rounded bg-muted/60" />
          <div className="h-4 w-2/3 rounded bg-muted/60" />
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-4 py-3 animate-pulse">
        <div className="h-8 w-20 rounded-md bg-muted/50" />
        <div className="h-8 w-24 rounded-md bg-muted/50" />
      </footer>
    </aside>
  );
}

function UnavailableMailDraftSidebar({
  action,
  close,
  message,
}: {
  readonly action?: ReactNode;
  readonly close: () => void;
  readonly message: string;
}) {
  return (
    <aside
      aria-label="Email details"
      className="flex h-full w-full flex-col border-l border-border/60 bg-background xl:border-l-0"
    >
      <div className="flex min-h-14 items-center border-b border-border/60 px-4">
        <span className="min-w-0 flex-1 text-sm font-medium">Email</span>
        <SidebarCloseButton close={close} />
      </div>
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div className="grid max-w-sm justify-items-center gap-4">
          <p className="text-sm text-muted-foreground">{message}</p>
          {action}
        </div>
      </div>
    </aside>
  );
}

function GmailReconnectButton({
  signals,
}: {
  readonly signals: MailDraftSignals;
}) {
  const reloadDraft = useSet(signals.reloadDraft$);
  const { reconnect, reconnectDisabled, reconnecting } =
    useGmailReconnect(reloadDraft);
  return (
    <Button
      type="button"
      size="sm"
      disabled={reconnectDisabled}
      onClick={reconnect}
    >
      {reconnecting ? <IconLoader2 size={15} className="animate-spin" /> : null}
      {reconnecting ? "Reconnecting…" : "Reconnect Gmail"}
    </Button>
  );
}

function MailMessageHeader({
  close,
  draft,
}: {
  readonly close: () => void;
  readonly draft: ZeroMailDraft;
}) {
  const active = draft.status === "draft";
  const senderName = draft.fromName?.trim() || null;
  const senderInitial = (senderName ?? draft.from).slice(0, 1).toUpperCase();
  return (
    <header className="border-b border-border/60 pb-5">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h1 className="break-words text-xl font-semibold leading-7 tracking-[-0.015em] text-foreground">
            {draft.subject || "(No subject)"}
          </h1>
          <span
            className={
              active
                ? "relative top-0.5 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                : "relative top-0.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
            }
          >
            {active ? (
              <IconPencil size={11} stroke={2} />
            ) : (
              <IconCircleCheck size={11} stroke={2} />
            )}
            {active ? "Draft" : "Sent"}
          </span>
        </div>
        <SidebarCloseButton close={close} />
      </div>
      <div className="mt-4 flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/[0.07] text-sm font-semibold text-foreground/75">
          {senderInitial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            {senderName ? (
              <span className="truncate text-sm font-semibold text-foreground">
                {senderName}
              </span>
            ) : null}
            <span
              className={
                senderName
                  ? "truncate text-xs text-muted-foreground"
                  : "truncate text-sm font-semibold text-foreground"
              }
            >
              {draft.from}
            </span>
          </div>
          <div className="mt-0.5 min-w-0 break-words text-xs leading-5 text-muted-foreground">
            <span>to {draft.to.join(", ") || "—"}</span>
            {draft.cc.length > 0 ? (
              <>
                <span aria-hidden="true"> · </span>
                <span>cc {draft.cc.join(", ")}</span>
              </>
            ) : null}
            {draft.bcc.length > 0 ? (
              <>
                <span aria-hidden="true"> · </span>
                <span>bcc {draft.bcc.join(", ")}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </header>
  );
}

function AttachmentSummary({
  attachment,
}: {
  readonly attachment: ZeroMailAttachment;
}) {
  return (
    <div className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md border border-foreground/15 bg-background/80 px-1.5">
      <IconPaperclip size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-xs font-medium">
        {attachment.filename}
      </span>
    </div>
  );
}

function MailAttachmentPreview({
  attachment,
  text$,
  url,
}: {
  readonly attachment: ZeroMailAttachment;
  readonly text$?: TextPreviewComputed;
  readonly url: string | null | undefined;
}) {
  if (!url) {
    return <AttachmentSummary attachment={attachment} />;
  }
  const kind = classifyChatAttachment({
    filename: attachment.filename,
    contentType: attachment.contentType,
    url,
  });
  let preview: ReactNode;
  if (kind === "image" || kind === "video") {
    preview = (
      <MailMediaAttachmentPreview
        filename={attachment.filename}
        kind={kind}
        url={url}
      />
    );
  } else if (
    kind === "markdown" ||
    kind === "text" ||
    kind === "json" ||
    kind === "csv" ||
    kind === "pdf"
  ) {
    preview = (
      <PreviewableFileAttachmentChip
        filename={attachment.filename}
        kind={kind}
        shareAvailable={false}
        splitViewAvailable={false}
        text$={isTextPreviewKind(kind) ? text$ : undefined}
        url={url}
      />
    );
  } else if (kind === "audio") {
    preview = (
      <PreviewableAudioAttachmentChip
        contentType={attachment.contentType}
        filename={attachment.filename}
        shareAvailable={false}
        splitViewAvailable={false}
        url={url}
      />
    );
  } else {
    preview = (
      <FileAttachmentChip
        contentType={attachment.contentType}
        filename={attachment.filename}
        url={url}
      />
    );
  }
  return preview;
}

function MailMediaAttachmentPreview({
  filename,
  kind,
  url,
}: {
  readonly filename: string;
  readonly kind: "image" | "video";
  readonly url: string;
}) {
  const openImageLightbox = useSet(openImageLightbox$);
  const openVideoLightbox = useSet(openVideoLightbox$);
  const onPreview = () => {
    if (kind === "image") {
      openImageLightbox({
        url,
        filename,
        shareAvailable: false,
        splitViewAvailable: false,
      });
      return;
    }
    openVideoLightbox({
      url,
      filename,
      shareAvailable: false,
      splitViewAvailable: false,
    });
  };
  return (
    <button
      type="button"
      onClick={onPreview}
      aria-label={`Preview ${filename}`}
      title={filename}
      className="group relative aspect-[10/9] w-[50px] max-w-full cursor-pointer overflow-hidden rounded-lg border border-foreground/10 bg-muted/30 shadow-sm transition-all duration-200 hover:scale-[1.015] hover:border-foreground/20 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30"
    >
      {kind === "image" ? (
        <img
          src={url}
          alt={filename}
          className="block h-full w-full object-contain"
        />
      ) : (
        <>
          <video
            src={`${url}#t=0.001`}
            preload="metadata"
            muted
            playsInline
            aria-hidden="true"
            className="h-full w-full object-contain"
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/10 text-white transition-colors group-hover:bg-black/30">
            <IconPlayerPlay size={16} stroke={1.8} />
          </span>
        </>
      )}
    </button>
  );
}

function MailDraftInlineImage({
  image,
  imageUrl,
}: {
  readonly image: ZeroMailInlineImage;
  readonly imageUrl: string | null | undefined;
}) {
  if (imageUrl === undefined) {
    return (
      <span
        aria-label={`Loading ${image.alt}`}
        className="my-2 inline-block aspect-video w-full rounded-lg bg-muted/50 align-middle animate-pulse"
      />
    );
  }
  if (imageUrl === null) {
    return (
      <span className="text-sm text-muted-foreground">
        [Image unavailable: {image.alt}]
      </span>
    );
  }
  return (
    <img
      src={imageUrl}
      alt={image.alt}
      className="max-h-80 max-w-full rounded-lg object-contain"
    />
  );
}

const BLOCKED_MAIL_HTML_ELEMENTS = [
  "audio",
  "button",
  "canvas",
  "embed",
  "form",
  "head",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "object",
  "option",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "textarea",
  "title",
  "video",
] as const;

function blockedMailHtmlElement(value: string): boolean {
  return BLOCKED_MAIL_HTML_ELEMENTS.some((candidate) => {
    return candidate === value;
  });
}

const ALLOWED_MAIL_HTML_ELEMENTS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "center",
  "code",
  "del",
  "div",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "ins",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
] as const;

type AllowedMailHtmlElement = (typeof ALLOWED_MAIL_HTML_ELEMENTS)[number];

function allowedMailHtmlElement(value: string): AllowedMailHtmlElement | null {
  return (
    ALLOWED_MAIL_HTML_ELEMENTS.find((candidate) => {
      return candidate === value;
    }) ?? null
  );
}

function normalizedContentId(value: string): string {
  return value
    .trim()
    .replace(/^cid:/iu, "")
    .replace(/^<|>$/gu, "")
    .toLowerCase();
}

function safeMailHref(value: string | null): string | undefined {
  if (!value || !URL.canParse(value)) {
    return undefined;
  }
  const protocol = new URL(value).protocol;
  return ["http:", "https:", "mailto:", "tel:"].includes(protocol)
    ? value
    : undefined;
}

function safeMailImageSrc(value: string | null): string | undefined {
  if (!value || !URL.canParse(value)) {
    return undefined;
  }
  return new URL(value).protocol === "https:" ? value : undefined;
}

function supportedFontSize(value: string): string | undefined {
  const keywordSizes = new Set([
    "xx-small",
    "x-small",
    "small",
    "medium",
    "large",
    "x-large",
    "xx-large",
    "smaller",
    "larger",
  ]);
  if (keywordSizes.has(value)) {
    return value;
  }
  const match = value.match(/^(\d+(?:\.\d+)?)(px|pt|em|rem|%)$/u);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const size = Number.parseFloat(match[1]);
  const limits: Readonly<Record<string, number>> = {
    px: 72,
    pt: 54,
    em: 4,
    rem: 4,
    "%": 400,
  };
  return size > 0 && size <= (limits[match[2]] ?? 0) ? value : undefined;
}

const MAIL_FONT_WEIGHTS: Readonly<Record<string, CSSProperties["fontWeight"]>> =
  {
    normal: "normal",
    bold: "bold",
    bolder: "bolder",
    lighter: "lighter",
  };
const MAIL_FONT_STYLES: Readonly<Record<string, CSSProperties["fontStyle"]>> = {
  normal: "normal",
  italic: "italic",
  oblique: "oblique",
};
const MAIL_TEXT_ALIGNMENTS: Readonly<
  Record<string, CSSProperties["textAlign"]>
> = {
  left: "left",
  right: "right",
  center: "center",
  justify: "justify",
};
const MAIL_TEXT_DIRECTIONS: Readonly<
  Record<string, CSSProperties["direction"]>
> = {
  ltr: "ltr",
  rtl: "rtl",
};
const MAIL_LEGACY_FONT_SIZES: Readonly<Record<string, string>> = {
  "1": "0.625rem",
  "2": "0.8125rem",
  "3": "1rem",
  "4": "1.125rem",
  "5": "1.5rem",
  "6": "2rem",
  "7": "3rem",
};

function mailTypographyStyle(source: CSSStyleDeclaration): CSSProperties {
  const style: CSSProperties = {};
  const fontWeight = MAIL_FONT_WEIGHTS[source.fontWeight];
  if (fontWeight) {
    style.fontWeight = fontWeight;
  } else if (/^[1-9]00$/u.test(source.fontWeight)) {
    style.fontWeight = Number.parseInt(source.fontWeight, 10);
  }
  const fontStyle = MAIL_FONT_STYLES[source.fontStyle];
  if (fontStyle) {
    style.fontStyle = fontStyle;
  }
  if (
    /^(?:none|underline|line-through|underline line-through|line-through underline)$/u.test(
      source.textDecorationLine,
    )
  ) {
    style.textDecorationLine = source.textDecorationLine;
  }
  const fontSize = supportedFontSize(source.fontSize);
  if (fontSize) {
    style.fontSize = fontSize;
  }
  return style;
}

function mailColorStyle(element: HTMLElement): CSSProperties {
  const style: CSSProperties = {};
  const source = element.style;
  if (source.color && source.color.length <= 100) {
    style.color = source.color;
  }
  if (source.backgroundColor && source.backgroundColor.length <= 100) {
    style.backgroundColor = source.backgroundColor;
  }
  const legacyColor = element.getAttribute("color");
  if (!style.color && legacyColor && legacyColor.length <= 100) {
    style.color = legacyColor;
  }
  return style;
}

function mailLayoutStyle(element: HTMLElement): CSSProperties {
  const source = element.style;
  const textAlign = MAIL_TEXT_ALIGNMENTS[source.textAlign];
  const direction = MAIL_TEXT_DIRECTIONS[source.direction];
  return {
    ...(textAlign ? { textAlign } : {}),
    ...(direction ? { direction } : {}),
    ...(element.tagName.toLowerCase() === "center"
      ? { textAlign: "center" }
      : {}),
  };
}

function mailLegacyFontStyle(element: HTMLElement): CSSProperties {
  const legacySize = element.getAttribute("size");
  const fontSize = legacySize ? MAIL_LEGACY_FONT_SIZES[legacySize] : undefined;
  return fontSize ? { fontSize } : {};
}

function mailRichTextStyle(element: HTMLElement): CSSProperties | undefined {
  const style: CSSProperties = {
    ...mailLegacyFontStyle(element),
    ...mailTypographyStyle(element.style),
    ...mailColorStyle(element),
    ...mailLayoutStyle(element),
  };
  return Object.keys(style).length > 0 ? style : undefined;
}

interface MailHtmlElementProps {
  readonly className?: string;
  readonly colSpan?: number;
  readonly href?: string;
  readonly rel?: string;
  readonly rowSpan?: number;
  readonly start?: number;
  readonly style?: CSSProperties;
  readonly target?: string;
  readonly title?: string;
}

function positiveIntegerAttribute(
  element: Element,
  name: string,
): number | undefined {
  const parsed = Number.parseInt(element.getAttribute(name) ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isElementNode(node: ChildNode): node is Element {
  return node.nodeType === 1;
}

function renderMailImage(args: {
  readonly element: Element;
  readonly key: string;
  readonly inlineImages: ReadonlyMap<string, ZeroMailInlineImage>;
  readonly inlineImageUrls: ReadonlyMap<string, string | null> | null;
  readonly inlineImageUrlsLoading: boolean;
}): ReactNode {
  const source = args.element.getAttribute("src");
  const image = source?.toLowerCase().startsWith("cid:")
    ? args.inlineImages.get(normalizedContentId(source))
    : undefined;
  if (image) {
    const imageUrl = args.inlineImageUrlsLoading
      ? undefined
      : (args.inlineImageUrls?.get(image.partId) ?? null);
    return (
      <MailDraftInlineImage key={args.key} image={image} imageUrl={imageUrl} />
    );
  }
  const remoteSource = safeMailImageSrc(source);
  if (!remoteSource) {
    return null;
  }
  return (
    <img
      key={args.key}
      src={remoteSource}
      alt={args.element.getAttribute("alt") ?? ""}
      title={args.element.getAttribute("title") ?? undefined}
      width={positiveIntegerAttribute(args.element, "width")}
      height={positiveIntegerAttribute(args.element, "height")}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="my-2 inline-block max-h-80 max-w-full object-contain align-middle"
    />
  );
}

function mailHtmlElementProps(args: {
  readonly element: Element;
  readonly tag: AllowedMailHtmlElement;
  readonly href?: string;
}): MailHtmlElementProps {
  const title = args.element.getAttribute("title") ?? undefined;
  return {
    ...(args.element instanceof HTMLElement
      ? { style: mailRichTextStyle(args.element) }
      : {}),
    ...(args.href
      ? {
          href: args.href,
          target: "_blank",
          rel: "noreferrer",
        }
      : {}),
    ...(title ? { title } : {}),
    ...(args.tag === "td" || args.tag === "th"
      ? {
          colSpan: positiveIntegerAttribute(args.element, "colspan"),
          rowSpan: positiveIntegerAttribute(args.element, "rowspan"),
        }
      : {}),
    ...(args.tag === "ol"
      ? { start: positiveIntegerAttribute(args.element, "start") }
      : {}),
    ...(!args.href && args.tag === "a" ? { className: "contents" } : {}),
  };
}

function renderAllowedMailElement(args: {
  readonly tag: AllowedMailHtmlElement;
  readonly key: string;
  readonly href?: string;
  readonly props: MailHtmlElementProps;
  readonly children: readonly ReactNode[];
}): ReactNode {
  if (args.tag === "br") {
    return <br key={args.key} {...args.props} />;
  }
  if (args.tag === "hr") {
    return <hr key={args.key} {...args.props} />;
  }
  if (args.tag === "a" && !args.href) {
    return (
      <span key={args.key} {...args.props}>
        {args.children}
      </span>
    );
  }
  const MailElement =
    args.tag === "font"
      ? "span"
      : args.tag === "center"
        ? "div"
        : args.tag === "strike"
          ? "s"
          : args.tag;
  return (
    <MailElement key={args.key} {...args.props}>
      {args.children}
    </MailElement>
  );
}

function renderMailHtmlNode(args: {
  readonly node: ChildNode;
  readonly key: string;
  readonly inlineImages: ReadonlyMap<string, ZeroMailInlineImage>;
  readonly inlineImageUrls: ReadonlyMap<string, string | null> | null;
  readonly inlineImageUrlsLoading: boolean;
}): ReactNode {
  if (args.node.nodeType === 3) {
    return args.node.textContent;
  }
  if (!isElementNode(args.node)) {
    return null;
  }
  const element = args.node;
  const tag = element.tagName.toLowerCase();
  if (blockedMailHtmlElement(tag)) {
    return null;
  }
  if (tag === "img") {
    return renderMailImage({
      element,
      key: args.key,
      inlineImages: args.inlineImages,
      inlineImageUrls: args.inlineImageUrls,
      inlineImageUrlsLoading: args.inlineImageUrlsLoading,
    });
  }
  const children = Array.from(element.childNodes).map((child, index) => {
    return renderMailHtmlNode({
      node: child,
      key: `${args.key}-${index}`,
      inlineImages: args.inlineImages,
      inlineImageUrls: args.inlineImageUrls,
      inlineImageUrlsLoading: args.inlineImageUrlsLoading,
    });
  });
  const allowedTag = allowedMailHtmlElement(tag);
  if (!allowedTag) {
    return children;
  }

  const href =
    allowedTag === "a" ? safeMailHref(element.getAttribute("href")) : undefined;
  return renderAllowedMailElement({
    tag: allowedTag,
    key: args.key,
    href,
    props: mailHtmlElementProps({
      element,
      tag: allowedTag,
      href,
    }),
    children,
  });
}

function MailDraftRichMessage({
  attachmentUrls,
  attachmentUrlsLoading,
  draft,
  signals,
}: {
  readonly attachmentUrls: ReadonlyMap<string, string | null> | null;
  readonly attachmentUrlsLoading: boolean;
  readonly draft: ZeroMailDraft;
  readonly signals: MailDraftSignals;
}) {
  if (!draft.bodyHtml || typeof DOMParser === "undefined") {
    return null;
  }
  const document = new DOMParser().parseFromString(draft.bodyHtml, "text/html");
  const inlineImages = new Map(
    (draft.inlineImages ?? []).map((image) => {
      return [normalizedContentId(image.contentId), image] as const;
    }),
  );
  return (
    <div
      data-feedback-source
      data-feedback-source-type="mail"
      data-feedback-source-id={signals.mailDraftId}
      data-feedback-source-status={draft.status === "draft" ? "draft" : "sent"}
      data-feedback-source-sent-id={draft.sentGmailMessageId}
      className="break-words text-sm leading-6 text-foreground [&_a]:text-primary [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_hr]:my-3 [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc"
    >
      {Array.from(document.body.childNodes).map((node, index) => {
        return renderMailHtmlNode({
          node,
          key: `mail-html-${index}`,
          inlineImages,
          inlineImageUrls: attachmentUrls,
          inlineImageUrlsLoading: attachmentUrlsLoading,
        });
      })}
    </div>
  );
}

function MailDraftMessage({
  attachmentUrls,
  attachmentUrlsLoading,
  draft,
  signals,
}: {
  readonly attachmentUrls: ReadonlyMap<string, string | null> | null;
  readonly attachmentUrlsLoading: boolean;
  readonly draft: ZeroMailDraft;
  readonly signals: MailDraftSignals;
}) {
  if (draft.bodyHtml && typeof DOMParser !== "undefined") {
    return (
      <MailDraftRichMessage
        attachmentUrls={attachmentUrls}
        attachmentUrlsLoading={attachmentUrlsLoading}
        draft={draft}
        signals={signals}
      />
    );
  }
  return (
    <div
      data-feedback-source
      data-feedback-source-type="mail"
      data-feedback-source-id={signals.mailDraftId}
      data-feedback-source-status={draft.status === "draft" ? "draft" : "sent"}
      data-feedback-source-sent-id={draft.sentGmailMessageId}
      className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground"
    >
      {draft.body || "(No message)"}
    </div>
  );
}

function MailDraftDetails({
  close,
  draft,
  signals,
}: {
  readonly close: () => void;
  readonly draft: ZeroMailDraft;
  readonly signals: MailDraftSignals;
}) {
  const setAttachmentScopeRef = useSet(signals.setAttachmentScopeRef$);
  const attachmentPreviewsLoadable = useLoadable(signals.attachmentPreviews$);
  const attachmentPreviews =
    attachmentPreviewsLoadable.state === "hasData"
      ? attachmentPreviewsLoadable.data
      : null;
  const attachmentUrls = attachmentPreviews?.urls ?? null;
  const attachmentUrlsLoading = attachmentPreviewsLoadable.state === "loading";
  const attachments = draft.version === 3 ? draft.attachments : [];
  return (
    <div
      ref={setAttachmentScopeRef}
      className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
    >
      <MailMessageHeader close={close} draft={draft} />
      <div className="py-5">
        <MailDraftMessage
          attachmentUrls={attachmentUrls}
          attachmentUrlsLoading={attachmentUrlsLoading}
          draft={draft}
          signals={signals}
        />
      </div>
      {attachments.length > 0 ? (
        <div className="grid gap-2.5 border-t border-border/60 pt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Attachments
          </div>
          <div className="flex flex-wrap gap-3">
            {attachments.map((attachment) => {
              const key = `${attachment.filename}-${attachment.contentType}-${attachment.size}`;
              return attachment.partId ? (
                <MailAttachmentPreview
                  key={key}
                  attachment={attachment}
                  text$={attachmentPreviews?.text.get(attachment.partId)}
                  url={
                    attachmentUrlsLoading
                      ? undefined
                      : (attachmentUrls?.get(attachment.partId) ?? null)
                  }
                />
              ) : (
                <AttachmentSummary key={key} attachment={attachment} />
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MailDraftDetail({
  draft,
  signals,
  close,
}: {
  readonly draft: ZeroMailDraft;
  readonly signals: MailDraftSignals;
  readonly close: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const featureSwitches = useGet(featureSwitch$);
  const [deleteLoadable, deleteDraft] = useLoadableSet(signals.delete$);
  const [sendLoadable, send] = useLoadableSet(signals.send$);
  const localFollowUpState = useGet(signals.followUpState$);
  const followUp = useSet(signals.followUp$);
  const followUpState =
    localFollowUpState === "submitting"
      ? localFollowUpState
      : (draft.followUp?.status ?? localFollowUpState);
  const followUpSubmitting = followUpState === "submitting";
  const followUpActive = followUpState === "active";
  const followUpPaused = followUpState === "paused";
  const followUpEnabled =
    featureSwitches[FeatureSwitchKey.ZeroMailReplyFollowUp];
  const active = draft.status === "draft";
  const pending =
    deleteLoadable.state === "loading" ||
    sendLoadable.state === "loading" ||
    followUpSubmitting;
  const openInGmail = draft.gmailThreadId
    ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(draft.gmailThreadId)}`
    : null;

  const onDelete = () => {
    const deleteAndClose = async () => {
      await deleteDraft(pageSignal);
      close();
    };
    detach(deleteAndClose(), Reason.DomCallback);
  };
  const onSend = () => {
    const sendAndNotify = async () => {
      await send(pageSignal);
      toast.success("Email sent");
    };
    detach(sendAndNotify(), Reason.DomCallback);
  };
  const onFollowUp = () => {
    detach(followUp(pageSignal), Reason.DomCallback);
  };

  return (
    <aside
      aria-label="Email details"
      data-chat-thread-container-id={signals.threadId}
      data-testid="mail-draft-sidebar"
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0 animate-in fade-in slide-in-from-right-2 duration-[180ms] ease"
    >
      <MailDraftDetails close={close} draft={draft} signals={signals} />
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            {deleteLoadable.state === "loading" ? (
              <IconLoader2 size={15} className="animate-spin" />
            ) : (
              <IconTrash size={15} />
            )}
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {openInGmail ? (
            <Button asChild variant="outline" size="sm">
              <a href={openInGmail} target="_blank" rel="noreferrer">
                <IconExternalLink size={15} />
                Open in Gmail
              </a>
            </Button>
          ) : null}
          {active ? (
            <Button type="button" size="sm" disabled={pending} onClick={onSend}>
              {sendLoadable.state === "loading" ? (
                <IconLoader2 size={15} className="animate-spin" />
              ) : (
                <IconSend size={15} />
              )}
              Send
            </Button>
          ) : null}
          {!active && followUpEnabled ? (
            <Button
              type="button"
              size="sm"
              disabled={pending || followUpState !== "idle"}
              onClick={onFollowUp}
            >
              {followUpSubmitting ? (
                <IconLoader2 size={15} className="animate-spin" />
              ) : followUpActive ? (
                <IconCircleCheck size={15} />
              ) : (
                <IconRoute size={15} />
              )}
              {followUpActive
                ? "Tracking replies"
                : followUpPaused
                  ? "Tracking paused"
                  : followUpSubmitting
                    ? "Setting up…"
                    : "Follow up"}
            </Button>
          ) : null}
        </div>
      </footer>
    </aside>
  );
}

export function MailDraftSidebar({ signals, onClose }: MailDraftSidebarProps) {
  const draftLoadable = useLastLoadable(signals.sidebarDraft$);
  const legacyClose = useSet(closeMailDraftSidebar$);
  const close = onClose ?? legacyClose;
  if (draftLoadable.state === "loading") {
    return <MailDraftSidebarSkeleton close={close} />;
  }
  if (draftLoadable.state === "hasError" || draftLoadable.data === null) {
    return (
      <UnavailableMailDraftSidebar
        close={close}
        message="This email is no longer available."
      />
    );
  }
  if (draftLoadable.data.accessStatus === "reconnect") {
    return (
      <UnavailableMailDraftSidebar
        close={close}
        message="You no longer have permission to access this email. Reconnect Gmail to continue."
        action={<GmailReconnectButton signals={signals} />}
      />
    );
  }
  if (draftLoadable.data.status === "deleted") {
    return (
      <UnavailableMailDraftSidebar
        close={close}
        message="This draft was deleted."
      />
    );
  }
  return (
    <MailDraftDetail
      draft={draftLoadable.data}
      signals={signals}
      close={close}
    />
  );
}
