import type { Plugin } from "vite";

const APP_ENTRY_ATTRIBUTE = "data-vm0-app-entry";
const APP_STYLESHEET_ATTRIBUTE = "data-vm0-app-stylesheet";

function tagAttributes(tag: string): ReadonlyMap<string, string | undefined> {
  const attributes = new Map<string, string | undefined>();
  const pattern = /\s([A-Za-z_:][A-Za-z0-9:._-]*)(?:="([^"]*)")?/gu;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      attributes.set(name, match[2]);
    }
  }
  return attributes;
}

function attributeValue(tag: string, name: string): string | undefined {
  return tagAttributes(tag).get(name);
}

function hasAttribute(tag: string, name: string): boolean {
  return tagAttributes(tag).has(name);
}

function preloadTag(
  sourceTag: string,
  href: string,
  relation: "modulepreload" | "preload",
  as: "style" | undefined,
  marker: string,
): string {
  const crossorigin = hasAttribute(sourceTag, "crossorigin")
    ? " crossorigin"
    : "";
  const resourceType = as === undefined ? "" : ` as="${as}"`;
  return `<link rel="${relation}"${resourceType}${crossorigin} href="${href}" ${marker}="">`;
}

export function deferApplicationEntryResources(html: string): string {
  let applicationEntries = 0;
  const deferredEntryHtml = html.replace(
    /<script\b[^>]*>\s*<\/script>/gu,
    (tag) => {
      const href = attributeValue(tag, "src");
      const isSourceEntry = hasAttribute(tag, APP_ENTRY_ATTRIBUTE);
      const isBuiltEntry =
        attributeValue(tag, "type") === "module" && href?.endsWith(".js");
      if (!isSourceEntry && !isBuiltEntry) {
        return tag;
      }
      if (href === undefined) {
        throw new Error("Deferred app entry is missing its source URL");
      }
      applicationEntries += 1;
      return preloadTag(
        tag,
        href,
        "modulepreload",
        undefined,
        APP_ENTRY_ATTRIBUTE,
      );
    },
  );
  if (applicationEntries !== 1) {
    throw new Error(
      `Expected exactly one deferred app entry, found ${applicationEntries}`,
    );
  }

  return deferredEntryHtml.replace(/<link\b[^>]*>/gu, (tag) => {
    const href = attributeValue(tag, "href");
    if (
      attributeValue(tag, "rel") !== "stylesheet" ||
      href === undefined ||
      !href.endsWith(".css") ||
      !hasAttribute(tag, "crossorigin")
    ) {
      return tag;
    }
    return preloadTag(tag, href, "preload", "style", APP_STYLESHEET_ATTRIBUTE);
  });
}

export function deferredApplicationEntryHtmlPlugin(): Plugin {
  return {
    name: "platform-deferred-application-entry-html",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return deferApplicationEntryResources(html);
      },
    },
  };
}
