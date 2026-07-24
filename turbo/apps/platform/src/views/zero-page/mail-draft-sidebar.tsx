import {
  IconExternalLink,
  IconLoader2,
  IconPaperclip,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import type {
  ZeroMailAttachment,
  ZeroMailDraft,
  ZeroMailInlineImage,
} from "@vm0/api-contracts/contracts/zero-mail";
import { Button } from "@vm0/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { CSSProperties, ReactNode } from "react";

import type { MailDraftSignals } from "../../signals/chat-page/mail-draft.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { closeMailDraftSidebar$ } from "../../signals/zero-page/mail-draft-sidebar.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface MailDraftSidebarProps {
  readonly signals: MailDraftSignals;
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
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <div className="min-w-0 flex-1 space-y-1.5 animate-pulse">
          <div className="h-4 w-40 rounded bg-muted/60" />
          <div className="h-3 w-20 rounded bg-muted/50" />
          <div className="h-3 w-64 max-w-full rounded bg-muted/50" />
        </div>
        <SidebarCloseButton close={close} />
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-hidden px-4 py-4 animate-pulse">
        <div className="space-y-1.5">
          <div className="h-3 w-10 rounded bg-muted/50" />
          <div className="h-4 w-48 max-w-full rounded bg-muted/60" />
        </div>
        <div className="space-y-1.5">
          <div className="h-3 w-6 rounded bg-muted/50" />
          <div className="h-4 w-64 max-w-full rounded bg-muted/60" />
        </div>
        <div className="space-y-1.5">
          <div className="h-3 w-14 rounded bg-muted/50" />
          <div className="h-4 w-52 max-w-full rounded bg-muted/60" />
        </div>
        <div className="space-y-1.5">
          <div className="h-3 w-12 rounded bg-muted/50" />
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
  close,
  message,
}: {
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
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {message}
      </div>
    </aside>
  );
}

function DetailField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="break-words text-sm text-foreground">{value}</div>
    </div>
  );
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (value < 1024 || i === units.length - 1) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value = value / 1024;
  }
  return `${bytes} B`;
}

function AttachmentSummary({
  attachment,
}: {
  readonly attachment: ZeroMailAttachment;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-gray-50 px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
        <IconPaperclip size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">
          {attachment.filename}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {formatAttachmentSize(attachment.size)}
        </span>
      </span>
    </div>
  );
}

function MailDraftInlineImage({
  image,
  signals,
}: {
  readonly image: ZeroMailInlineImage;
  readonly signals: MailDraftSignals;
}) {
  const imageLoadable = useLoadable(signals.attachmentImageUrl(image.partId));
  if (imageLoadable.state === "loading") {
    return (
      <span
        aria-label={`Loading ${image.alt}`}
        className="my-2 inline-block aspect-video w-full rounded-lg bg-muted/50 align-middle animate-pulse"
      />
    );
  }
  if (imageLoadable.state === "hasError" || imageLoadable.data === null) {
    return (
      <span className="text-sm text-muted-foreground">
        [Image unavailable: {image.alt}]
      </span>
    );
  }
  return (
    <img
      src={imageLoadable.data}
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

function renderInlineMailImage(args: {
  readonly element: Element;
  readonly key: string;
  readonly inlineImages: ReadonlyMap<string, ZeroMailInlineImage>;
  readonly signals: MailDraftSignals;
}): ReactNode {
  const source = args.element.getAttribute("src");
  const image = source?.toLowerCase().startsWith("cid:")
    ? args.inlineImages.get(normalizedContentId(source))
    : undefined;
  return image ? (
    <MailDraftInlineImage key={args.key} image={image} signals={args.signals} />
  ) : null;
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
  readonly signals: MailDraftSignals;
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
    return renderInlineMailImage({
      element,
      key: args.key,
      inlineImages: args.inlineImages,
      signals: args.signals,
    });
  }
  const children = Array.from(element.childNodes).map((child, index) => {
    return renderMailHtmlNode({
      node: child,
      key: `${args.key}-${index}`,
      inlineImages: args.inlineImages,
      signals: args.signals,
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
  draft,
  signals,
}: {
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
          signals,
        });
      })}
    </div>
  );
}

function MailDraftMessage({
  draft,
  signals,
}: {
  readonly draft: ZeroMailDraft;
  readonly signals: MailDraftSignals;
}) {
  if (draft.bodyHtml && typeof DOMParser !== "undefined") {
    return <MailDraftRichMessage draft={draft} signals={signals} />;
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
  draft,
  signals,
}: {
  readonly draft: ZeroMailDraft;
  readonly signals: MailDraftSignals;
}) {
  const attachments = draft.version === 3 ? draft.attachments : [];
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
      <DetailField
        label="From"
        value={
          draft.fromName ? `${draft.fromName} <${draft.from}>` : draft.from
        }
      />
      <DetailField label="To" value={draft.to.join(", ") || "—"} />
      {draft.cc.length > 0 ? (
        <DetailField label="Cc" value={draft.cc.join(", ")} />
      ) : null}
      {draft.bcc.length > 0 ? (
        <DetailField label="Bcc" value={draft.bcc.join(", ")} />
      ) : null}
      <DetailField label="Subject" value={draft.subject || "(No subject)"} />
      <div className="grid gap-1.5">
        <div className="text-xs font-medium text-muted-foreground">Message</div>
        <MailDraftMessage draft={draft} signals={signals} />
      </div>
      {attachments.length > 0 ? (
        <div className="grid gap-2">
          <div className="text-xs font-medium text-muted-foreground">
            Attachments
          </div>
          <div className="grid gap-2">
            {attachments.map((attachment) => {
              const key = `${attachment.filename}-${attachment.contentType}-${attachment.size}`;
              return <AttachmentSummary key={key} attachment={attachment} />;
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
  const [deleteLoadable, deleteDraft] = useLoadableSet(signals.delete$);
  const [sendLoadable, send] = useLoadableSet(signals.send$);
  const active = draft.status === "draft";
  const pending =
    deleteLoadable.state === "loading" || sendLoadable.state === "loading";
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

  return (
    <aside
      aria-label="Email details"
      data-chat-thread-container-id={signals.threadId}
      data-testid="mail-draft-sidebar"
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0 animate-in fade-in slide-in-from-right-2 duration-[180ms] ease"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {draft.subject || "(No subject)"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {active ? "Gmail draft" : "Sent email"}
          </div>
        </div>
        <SidebarCloseButton close={close} />
      </div>
      <MailDraftDetails draft={draft} signals={signals} />
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
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => {
                detach(send(pageSignal), Reason.DomCallback);
              }}
            >
              {sendLoadable.state === "loading" ? (
                <IconLoader2 size={15} className="animate-spin" />
              ) : (
                <IconSend size={15} />
              )}
              Send
            </Button>
          ) : null}
        </div>
      </footer>
    </aside>
  );
}

export function MailDraftSidebar({ signals }: MailDraftSidebarProps) {
  const draftLoadable = useLoadable(signals.sidebarDraft$);
  const close = useSet(closeMailDraftSidebar$);
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
