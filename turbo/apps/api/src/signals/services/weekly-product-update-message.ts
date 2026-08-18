/**
 * Gate and renderer for the weekly product update that ships in Web Chat.
 *
 * The Resend broadcast is the trigger and the content source. Its HTML is a
 * marketing-authored email, so the renderer keeps the semantic spine
 * (headings, paragraphs, links, screenshots) and drops the email chrome:
 * preheader, logo, greeting merge tag, social nav, address, unsubscribe.
 */
import { convert, type DomNode, type FormatCallback } from "html-to-text";

interface WeeklyProductUpdateContent {
  readonly postSlug: string;
  readonly postUrl: string;
  readonly message: string;
}

type WeeklyProductUpdateResolution =
  | { readonly kind: "ready"; readonly content: WeeklyProductUpdateContent }
  | { readonly kind: "skipped"; readonly reason: string };

interface WeeklyProductUpdateBroadcast {
  readonly status: string;
  readonly subject: string | null;
  readonly html: string | null;
}

/**
 * Broadcast names are not a usable gate: three of the weekly sends in July 2026
 * went out named `Untitled`. Subjects have been stable, but the separator has
 * been `-`, `–`, `—`, `,` and `:` over time, and the brand prefix changes with
 * the Okou rebrand.
 */
const WEEKLY_SUBJECT_PATTERN =
  /^\s*(?:vm0|okou|zero)?\s*inside the build\s*[-–—,:]?\s*week of\b/i;

/**
 * The authoritative gate. Every weekly send since 2026-05-16 links exactly one
 * `whats-new-in-zero-week-of-*` post, and that slug is the second dedupe key.
 */
const WEEKLY_POST_LINK_PATTERN =
  /https?:\/\/[^\s"'<>]*\/blog\/posts\/(whats-new-in-zero-week-of-[a-z0-9-]+)/gi;

/** Template furniture that carries no product information. */
const CHROME_IMAGE_PATTERN = /vm0_cube_icon|zero-app-\d+\.png/i;

/** A footer nav is a run of links separated by nothing but punctuation. */
const CHROME_LINK_LINE_MIN_LINKS = 3;

const MERGE_TAG_PATTERN = /\{\{\{?[^{}]*\}?\}\}/g;
const GREETING_LINE_PATTERN = /^(?:hi|hello|hey)\b[\s,]*$/i;
const ADDRESS_LINE_PATTERN = /^\d+\s+.*\b[A-Z]{2}\s+\d{5}\s*$/;
const COPYRIGHT_LINE_PATTERN = /^©/;
const UNSUBSCRIBE_LINE_PATTERN = /\[[^\]]*unsubscribe[^\]]*\]\(/i;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\([^)]+\)/g;

function attribute(elem: DomNode, name: string): string | undefined {
  const attribs: unknown = elem.attribs;
  if (typeof attribs !== "object" || attribs === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(attribs, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `DomNode.children` is typed as required but is absent on text nodes. */
function children(elem: DomNode): DomNode[] {
  const nodes: DomNode[] | undefined = elem.children;
  return nodes ?? [];
}

function firstImage(elem: DomNode): DomNode | undefined {
  for (const child of children(elem)) {
    if (child.name === "img") {
      return child;
    }
    const nested = firstImage(child);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function textContent(elem: DomNode): string {
  if (elem.type === "text") {
    return elem.data ?? "";
  }
  return children(elem)
    .map((child) => {
      return textContent(child);
    })
    .join("");
}

function markdownImage(image: DomNode): string | undefined {
  const src = attribute(image, "src");
  if (!src || CHROME_IMAGE_PATTERN.test(src)) {
    return undefined;
  }
  return `![${attribute(image, "alt") ?? ""}](${src})`;
}

function headingFormatter(prefix: string): FormatCallback {
  return (elem, walk, builder) => {
    builder.openBlock({ leadingLineBreaks: 2 });
    walk(children(elem), builder);
    builder.closeBlock({
      trailingLineBreaks: 2,
      blockTransform: (text) => {
        const trimmed = text.trim();
        return trimmed ? `${prefix} ${trimmed}` : "";
      },
    });
  };
}

const linkFormatter: FormatCallback = (elem, walk, builder) => {
  const href = attribute(elem, "href");
  if (!href) {
    walk(children(elem), builder);
    return;
  }

  // A screenshot wrapped in a link must stay on one line, or the markdown
  // renders as a broken link around an orphaned image block.
  const image = firstImage(elem);
  if (image && textContent(elem).trim().length === 0) {
    const markdown = markdownImage(image);
    if (markdown) {
      builder.openBlock({ leadingLineBreaks: 2 });
      builder.addInline(`[${markdown}](${href})`, { noWordTransform: true });
      builder.closeBlock({ trailingLineBreaks: 2 });
    }
    return;
  }

  builder.addInline("[", { noWordTransform: true });
  walk(children(elem), builder);
  builder.addInline(`](${href})`, { noWordTransform: true });
};

const imageFormatter: FormatCallback = (elem, _walk, builder) => {
  const markdown = markdownImage(elem);
  if (!markdown) {
    return;
  }
  builder.openBlock({ leadingLineBreaks: 2 });
  builder.addInline(markdown, { noWordTransform: true });
  builder.closeBlock({ trailingLineBreaks: 2 });
};

function toMarkdown(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "h1", format: "weeklyHeading1" },
      { selector: "h2", format: "weeklyHeading2" },
      { selector: "h3", format: "weeklyHeading3" },
      { selector: "h4", format: "weeklyHeading3" },
      { selector: "h5", format: "weeklyHeading3" },
      { selector: "h6", format: "weeklyHeading3" },
      { selector: "a", format: "weeklyLink" },
      { selector: "img", format: "weeklyImage" },
      { selector: "table", format: "block" },
      { selector: "hr", format: "skip" },
    ],
    formatters: {
      weeklyHeading1: headingFormatter("#"),
      weeklyHeading2: headingFormatter("##"),
      weeklyHeading3: headingFormatter("###"),
      weeklyLink: linkFormatter,
      weeklyImage: imageFormatter,
    },
  });
}

/** True when the line is a footer nav rather than authored copy. */
function isChromeLinkLine(line: string): boolean {
  const links = line.match(MARKDOWN_LINK_PATTERN) ?? [];
  if (links.length < CHROME_LINK_LINE_MIN_LINKS) {
    return false;
  }
  return /^[\s·|,•-]*$/.test(line.replace(MARKDOWN_LINK_PATTERN, "").trim());
}

function isDroppableTrailingLine(line: string): boolean {
  return (
    line.trim().length === 0 ||
    ADDRESS_LINE_PATTERN.test(line.trim()) ||
    COPYRIGHT_LINE_PATTERN.test(line.trim()) ||
    isChromeLinkLine(line)
  );
}

/**
 * Slice the converted email down to the update itself: start at the first
 * markdown H1, stop before the unsubscribe footer, then trim the remaining
 * template furniture from both ends.
 */
function trimToUpdateBody(markdown: string): string {
  const lines = markdown.replace(MERGE_TAG_PATTERN, "").split("\n");

  const start = lines.findIndex((line) => {
    return line.startsWith("# ");
  });
  if (start === -1) {
    return "";
  }

  const unsubscribe = lines.findIndex((line) => {
    return UNSUBSCRIBE_LINE_PATTERN.test(line);
  });
  const end = unsubscribe === -1 ? lines.length : unsubscribe;

  const body = lines
    .slice(start, end)
    .filter((line) => {
      return !GREETING_LINE_PATTERN.test(line.trim());
    })
    .filter((line) => {
      return !isChromeLinkLine(line);
    });

  while (body.length > 0 && isDroppableTrailingLine(body[body.length - 1]!)) {
    body.pop();
  }

  return body
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function weeklyPostSlugs(html: string): readonly string[] {
  const slugs = new Set<string>();
  for (const match of html.matchAll(WEEKLY_POST_LINK_PATTERN)) {
    const slug = match[1];
    if (slug) {
      slugs.add(slug.toLowerCase());
    }
  }
  return [...slugs];
}

function weeklyPostUrl(html: string, slug: string): string | undefined {
  for (const match of html.matchAll(WEEKLY_POST_LINK_PATTERN)) {
    if (match[1]?.toLowerCase() === slug) {
      return match[0];
    }
  }
  return undefined;
}

/**
 * Decide whether a sent broadcast is a weekly product update and, when it is,
 * produce the Web Chat message once for every recipient.
 */
export function resolveWeeklyProductUpdate(
  broadcast: WeeklyProductUpdateBroadcast,
): WeeklyProductUpdateResolution {
  if (broadcast.status !== "sent") {
    return { kind: "skipped", reason: `broadcast-status-${broadcast.status}` };
  }
  if (!broadcast.subject || !WEEKLY_SUBJECT_PATTERN.test(broadcast.subject)) {
    return { kind: "skipped", reason: "subject-not-a-weekly-update" };
  }
  if (!broadcast.html) {
    return { kind: "skipped", reason: "broadcast-has-no-html" };
  }

  const slugs = weeklyPostSlugs(broadcast.html);
  if (slugs.length !== 1) {
    return {
      kind: "skipped",
      reason: `expected-one-weekly-post-link-found-${slugs.length}`,
    };
  }

  const postSlug = slugs[0]!;
  const postUrl = weeklyPostUrl(broadcast.html, postSlug);
  if (!postUrl) {
    return { kind: "skipped", reason: "weekly-post-link-not-resolved" };
  }

  const message = trimToUpdateBody(toMarkdown(broadcast.html));
  if (!message) {
    return { kind: "skipped", reason: "rendered-message-is-empty" };
  }

  return { kind: "ready", content: { postSlug, postUrl, message } };
}
