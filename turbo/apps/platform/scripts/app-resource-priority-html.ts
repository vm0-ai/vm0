import type { Plugin } from "vite";

const CRITICAL_STYLE_ID = "app-bootstrap-critical-styles";

function matchingTags(
  htmlSource: string,
  tagPattern: RegExp,
  assetPattern: RegExp,
): string[] {
  return [...htmlSource.matchAll(tagPattern)]
    .map((match) => {
      return match[0];
    })
    .filter((tag) => {
      return assetPattern.test(tag);
    });
}

function singleAssetTag(
  htmlSource: string,
  label: string,
  tagPattern: RegExp,
  assetPattern: RegExp,
): string {
  const tags = matchingTags(htmlSource, tagPattern, assetPattern);
  if (tags.length !== 1 || !tags[0]) {
    throw new Error(
      `Expected exactly one generated ${label} tag, but found ${tags.length}`,
    );
  }
  return tags[0];
}

function withFetchPriority(tag: string, priority: "high" | "low"): string {
  if (/\sfetchpriority=/u.test(tag)) {
    return tag.replace(
      /\sfetchpriority="[^"]*"/u,
      ` fetchpriority="${priority}"`,
    );
  }

  const startTagEnd = tag.indexOf(">");
  if (startTagEnd === -1) {
    throw new Error(
      `Generated asset tag is missing its closing bracket: ${tag}`,
    );
  }
  return `${tag.slice(0, startTagEnd)} fetchpriority="${priority}"${tag.slice(startTagEnd)}`;
}

function removeTag(htmlSource: string, tag: string): string {
  const firstIndex = htmlSource.indexOf(tag);
  const lastIndex = htmlSource.lastIndexOf(tag);
  if (firstIndex === -1 || firstIndex !== lastIndex) {
    throw new Error("Generated application resource tag is not unique");
  }
  return `${htmlSource.slice(0, firstIndex)}${htmlSource.slice(firstIndex + tag.length)}`;
}

function prioritizeApplicationResources(htmlSource: string): string {
  const linkTagPattern = /<link\b[^>]*>/gu;
  const scriptTagPattern = /<script\b[^>]*><\/script>/gu;
  const stylesheet = singleAssetTag(
    htmlSource,
    "application stylesheet",
    linkTagPattern,
    /\srel="stylesheet"[^>]*\shref="[^"]*\/assets\/index-[^"/]+\.css"/u,
  );
  const runtimePreload = singleAssetTag(
    htmlSource,
    "runtime module preload",
    linkTagPattern,
    /\srel="modulepreload"[^>]*\shref="[^"]*\/assets\/rolldown-runtime-[^"/]+\.js"/u,
  );
  const vendorPreload = singleAssetTag(
    htmlSource,
    "vendor module preload",
    linkTagPattern,
    /\srel="modulepreload"[^>]*\shref="[^"]*\/assets\/vendor-[^"/]+\.js"/u,
  );
  const applicationModule = singleAssetTag(
    htmlSource,
    "application module",
    scriptTagPattern,
    /\stype="module"[^>]*\ssrc="[^"]*\/assets\/index-[^"/]+\.js"/u,
  );

  let prioritizedHtml = htmlSource;
  for (const tag of [
    stylesheet,
    runtimePreload,
    vendorPreload,
    applicationModule,
  ]) {
    prioritizedHtml = removeTag(prioritizedHtml, tag);
  }

  const criticalStyleOpeningTag = `<style id="${CRITICAL_STYLE_ID}">`;
  const criticalStyleStart = prioritizedHtml.indexOf(criticalStyleOpeningTag);
  if (criticalStyleStart === -1) {
    throw new Error(
      `Expected the critical stylesheet marker #${CRITICAL_STYLE_ID}`,
    );
  }
  const criticalStyleEnd = prioritizedHtml.indexOf(
    "</style>",
    criticalStyleStart,
  );
  if (criticalStyleEnd === -1) {
    throw new Error("Critical application stylesheet is missing </style>");
  }
  const headResources = [
    withFetchPriority(stylesheet, "high"),
    withFetchPriority(runtimePreload, "low"),
    withFetchPriority(vendorPreload, "low"),
  ]
    .map((tag) => {
      return `    ${tag}`;
    })
    .join("\n");
  const criticalStyleInsertion = criticalStyleEnd + "</style>".length;
  prioritizedHtml = `${prioritizedHtml.slice(0, criticalStyleInsertion)}\n${headResources}${prioritizedHtml.slice(criticalStyleInsertion)}`;

  const bodyEnd = prioritizedHtml.lastIndexOf("</body>");
  if (bodyEnd === -1) {
    throw new Error("Application HTML is missing </body>");
  }
  const lowPriorityApplicationModule = withFetchPriority(
    applicationModule,
    "low",
  );
  const bodyClosingLineStart = prioritizedHtml.lastIndexOf("\n", bodyEnd) + 1;
  if (prioritizedHtml.slice(bodyClosingLineStart, bodyEnd).trim()) {
    return `${prioritizedHtml.slice(0, bodyEnd)}${lowPriorityApplicationModule}${prioritizedHtml.slice(bodyEnd)}`;
  }
  return `${prioritizedHtml.slice(0, bodyClosingLineStart)}    ${lowPriorityApplicationModule}\n${prioritizedHtml.slice(bodyClosingLineStart)}`;
}

export function applicationResourcePriorityHtmlPlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-application-resource-priority-html",
    transformIndexHtml: {
      order: "post",
      handler(htmlSource) {
        return prioritizeApplicationResources(htmlSource);
      },
    },
  };
}
