import { createHash } from "node:crypto";

import { transformWithEsbuild, type Plugin, type ResolvedConfig } from "vite";

const APP_ENTRY_ATTRIBUTE = "data-vm0-app-entry";
const APP_STYLESHEET_ATTRIBUTE = "data-vm0-app-stylesheet";
const AFTER_FIRST_PAINT_ENTRY_ATTRIBUTE = "data-vm0-after-first-paint-entry";
const AFTER_FIRST_PAINT_ENTRY_PLACEHOLDER =
  "__VM0_AFTER_FIRST_PAINT_ENTRY_URL__";
const AFTER_FIRST_PAINT_INTEGRITY_PLACEHOLDER =
  "__VM0_AFTER_FIRST_PAINT_ENTRY_INTEGRITY__";

type ExtractedAfterFirstPaintBootstrap = {
  readonly html: string;
  readonly source: string;
};

type InlineBlockKind = "script" | "style";

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

export function extractAfterFirstPaintBootstrap(
  html: string,
): ExtractedAfterFirstPaintBootstrap {
  const callbacks: string[] = [];
  let insertedEntrypoint = false;
  const extractedHtml = html.replace(
    /<script>([\s\S]*?)<\/script>/gu,
    (tag, source: string) => {
      if (!/^\s*window\.__vm0AfterFirstPaint\(function \(\) \{/u.test(source)) {
        return tag;
      }
      callbacks.push(source.trim());
      if (insertedEntrypoint) {
        return "";
      }
      insertedEntrypoint = true;
      return `<link rel="preload" as="script" crossorigin href="${AFTER_FIRST_PAINT_ENTRY_PLACEHOLDER}" integrity="${AFTER_FIRST_PAINT_INTEGRITY_PLACEHOLDER}" ${AFTER_FIRST_PAINT_ENTRY_ATTRIBUTE}="">
    <script data-vm0-after-first-paint-loader="">
      window.__vm0AfterFirstPaint(function () {
        var entry = document.querySelector(
          'link[${AFTER_FIRST_PAINT_ENTRY_ATTRIBUTE}=""]',
        );
        if (!entry) return;

        var script = document.createElement("script");
        script.src = entry.href;
        script.crossOrigin = "anonymous";
        script.integrity = entry.integrity;
        document.head.appendChild(script);
      });
    </script>`;
    },
  );
  if (callbacks.length === 0) {
    throw new Error("Expected deferred after-first-paint bootstrap callbacks");
  }

  return {
    html: extractedHtml,
    source: `"use strict";\n${callbacks.join("\n")}\n`,
  };
}

async function minifyInlineBlock(
  kind: InlineBlockKind,
  attributes: string,
  source: string,
): Promise<string> {
  if (source.trim() === "") {
    return source;
  }
  if (kind === "script") {
    const sourceTag = `<script${attributes}>`;
    if (hasAttribute(sourceTag, "src")) {
      return source;
    }
    const type = attributeValue(sourceTag, "type");
    if (type !== undefined && type !== "module" && type !== "text/javascript") {
      return source;
    }
  }
  const transformed = await transformWithEsbuild(
    source,
    kind === "script" ? "inline-bootstrap.js" : "inline-bootstrap.css",
    {
      legalComments: "none",
      loader: kind === "script" ? "js" : "css",
      minify: true,
      target: "es2020",
    },
  );
  return transformed.code.trim();
}

async function minifyInlineBootstrap(html: string): Promise<string> {
  const pattern = /<(script|style)([^>]*)>([\s\S]*?)<\/\1>/gu;
  const parts: string[] = [];
  let sourceOffset = 0;
  for (const match of html.matchAll(pattern)) {
    const fullMatch = match[0];
    const kind = match[1] as InlineBlockKind | undefined;
    const attributes = match[2];
    const source = match[3];
    if (
      fullMatch === undefined ||
      kind === undefined ||
      attributes === undefined ||
      source === undefined ||
      match.index === undefined
    ) {
      continue;
    }
    parts.push(html.slice(sourceOffset, match.index));
    const minified = await minifyInlineBlock(kind, attributes, source);
    parts.push(`<${kind}${attributes}>${minified}</${kind}>`);
    sourceOffset = match.index + fullMatch.length;
  }
  parts.push(html.slice(sourceOffset));
  return parts.join("");
}

function assetUrl(config: ResolvedConfig, fileName: string): string {
  return `${config.base.replace(/\/?$/u, "/")}${fileName}`;
}

export function deferredApplicationEntryHtmlPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig | undefined;
  return {
    name: "platform-deferred-application-entry-html",
    configResolved(config) {
      resolvedConfig = config;
    },
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        const deferredHtml = deferApplicationEntryResources(html);
        if (resolvedConfig?.command !== "build") {
          return deferredHtml;
        }
        const extracted = extractAfterFirstPaintBootstrap(deferredHtml);
        const minifiedSource = (
          await transformWithEsbuild(
            extracted.source,
            "bootstrap-after-first-paint.js",
            {
              legalComments: "none",
              loader: "js",
              minify: true,
              target: "es2020",
            },
          )
        ).code.trim();
        const digest = createHash("sha256")
          .update(minifiedSource)
          .digest("hex")
          .slice(0, 12);
        const fileName = `assets/bootstrap-after-first-paint-${digest}.js`;
        const integrity = `sha384-${createHash("sha384")
          .update(minifiedSource)
          .digest("base64")}`;
        this.emitFile({
          type: "asset",
          fileName,
          source: minifiedSource,
        });
        const entryUrl = assetUrl(resolvedConfig, fileName);
        return await minifyInlineBootstrap(
          extracted.html
            .replace(AFTER_FIRST_PAINT_ENTRY_PLACEHOLDER, entryUrl)
            .replace(AFTER_FIRST_PAINT_INTEGRITY_PLACEHOLDER, integrity),
        );
      },
    },
  };
}
