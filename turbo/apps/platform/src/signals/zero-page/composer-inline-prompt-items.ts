import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  findVideoTemplateItem,
  findWebsiteTemplateItem,
  findWorkflowTemplateItem,
} from "@vm0/core";
import { splitChatThreadMentionSegments } from "./chat-thread-suggestion-domain.ts";

export interface InlineTemplateMetadata {
  readonly type: GenerationTemplateRequest["type"];
  readonly selectionId: string;
  readonly colorSystemId?: string;
}

export interface ResolvedInlineTemplate {
  readonly metadata: InlineTemplateMetadata;
  readonly request: GenerationTemplateRequest;
  readonly title: string;
  readonly instruction: string;
}

export type InlinePromptLineSegment =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "template";
      readonly template: ResolvedInlineTemplate;
    }
  | {
      readonly type: "file";
      readonly filename: string;
      readonly url: string;
    }
  | {
      readonly type: "thread";
      readonly threadId: string;
      readonly title: string;
    };

const INLINE_TEMPLATE_COMMENT_PATTERN =
  /<!-- zero-template:v1 type="([^"]+)" id="([^"]+)"(?: color="([^"]+)")?; .*? -->/g;
const MARKDOWN_LINK_PATTERN =
  /\[((?:\\[\\[\]]|[^[\]\\])+)\]\((https:\/\/cdn\.(?:vm0|vm7)\.io\/artifacts\/[^)\s]+)\)/g;

export function inlineTemplateMetadataFromRequest(
  request: GenerationTemplateRequest,
): InlineTemplateMetadata {
  switch (request.type) {
    case "presentation": {
      return {
        type: request.type,
        selectionId: request.selection.templateId,
        ...(request.selection.colorSystemId
          ? { colorSystemId: request.selection.colorSystemId }
          : {}),
      };
    }
    case "illustration": {
      return {
        type: request.type,
        selectionId: request.selection.illustrationStyleId,
      };
    }
    case "video": {
      return {
        type: request.type,
        selectionId: request.selection.stylePresetId,
      };
    }
    case "workflow": {
      return {
        type: request.type,
        selectionId: request.selection.workflowTemplateId,
      };
    }
    case "website": {
      return {
        type: request.type,
        selectionId: request.selection.websiteTemplateId,
      };
    }
  }
}

function resolvePresentationTemplate(
  metadata: InlineTemplateMetadata,
): ResolvedInlineTemplate | null {
  const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
    return candidate.templateId === metadata.selectionId;
  });
  if (!item) {
    return null;
  }
  const colorInstruction = metadata.colorSystemId
    ? ` and the ${metadata.colorSystemId.replace("color-system:", "")} color system`
    : "";
  return {
    metadata,
    request: {
      type: "presentation",
      selection: {
        templateId: item.templateId,
        ...(metadata.colorSystemId
          ? { colorSystemId: metadata.colorSystemId }
          : {}),
      },
    },
    title: item.title,
    instruction:
      `For presentations, use this template${colorInstruction}. ` +
      `Start with \`zero generate presentation --template ${item.templateId} --prompt "<user request>"\`, then follow the returned packet.`,
  };
}

function resolveIllustrationTemplate(
  metadata: InlineTemplateMetadata,
): ResolvedInlineTemplate | null {
  const item = ILLUSTRATION_TEMPLATE_ITEMS.find((candidate) => {
    return candidate.illustrationStyleId === metadata.selectionId;
  });
  if (!item) {
    return null;
  }
  return {
    metadata,
    request: {
      type: "illustration",
      selection: { illustrationStyleId: item.illustrationStyleId },
    },
    title: item.title,
    instruction:
      "For illustrations, use this style. " +
      `Run \`zero generate image --provider built-in --style ${item.illustrationStyleId} --prompt "<user request>" --compile\`, then follow the returned packet.`,
  };
}

function resolveVideoTemplate(
  metadata: InlineTemplateMetadata,
): ResolvedInlineTemplate | null {
  const item = findVideoTemplateItem(metadata.selectionId);
  if (!item) {
    return null;
  }
  return {
    metadata,
    request: {
      type: "video",
      selection: { stylePresetId: item.id },
    },
    title: item.title,
    instruction:
      "For videos, use this template with " +
      `\`zero generate video --provider built-in --template ${item.id} --prompt "<user request>"\`.`,
  };
}

function resolveWorkflowTemplate(
  metadata: InlineTemplateMetadata,
): ResolvedInlineTemplate | null {
  const item = findWorkflowTemplateItem(metadata.selectionId);
  if (!item) {
    return null;
  }
  return {
    metadata,
    request: {
      type: "workflow",
      selection: { workflowTemplateId: item.id },
    },
    title: item.title,
    instruction:
      `For workflows, use this template: ${item.description} ` +
      "Use the workflow-setup skill to create or remix it; do not run an existing workflow.",
  };
}

function resolveWebsiteTemplate(
  metadata: InlineTemplateMetadata,
): ResolvedInlineTemplate | null {
  const item = findWebsiteTemplateItem(metadata.selectionId);
  if (!item) {
    return null;
  }
  return {
    metadata,
    request: {
      type: "website",
      selection: { websiteTemplateId: item.id },
    },
    title: item.title,
    instruction:
      "For websites, use this template. " +
      `Start with \`zero generate website --template ${item.templateId} --prompt "<user request>"\`, then follow the returned packet.`,
  };
}

export function resolveInlineTemplate(
  metadata: InlineTemplateMetadata,
): ResolvedInlineTemplate | null {
  switch (metadata.type) {
    case "presentation": {
      return resolvePresentationTemplate(metadata);
    }
    case "illustration": {
      return resolveIllustrationTemplate(metadata);
    }
    case "video": {
      return resolveVideoTemplate(metadata);
    }
    case "workflow": {
      return resolveWorkflowTemplate(metadata);
    }
    case "website": {
      return resolveWebsiteTemplate(metadata);
    }
  }
}

function isTemplateType(
  value: string,
): value is GenerationTemplateRequest["type"] {
  return (
    value === "presentation" ||
    value === "illustration" ||
    value === "video" ||
    value === "workflow" ||
    value === "website"
  );
}

export function serializeInlineTemplatePromptItem(
  metadata: InlineTemplateMetadata,
): string {
  const resolved = resolveInlineTemplate(metadata);
  if (!resolved) {
    throw new Error("Inline template is not present in the template registry");
  }
  const color = metadata.colorSystemId
    ? ` color="${metadata.colorSystemId}"`
    : "";
  return (
    `${resolved.title}<!-- zero-template:v1 type="${metadata.type}" ` +
    `id="${metadata.selectionId}"${color}; ${resolved.instruction} -->`
  );
}

export function serializeInlineFilePromptItem(
  filename: string,
  url: string,
): string {
  const escapedFilename = filename.replace(/[\\[\]]/g, String.raw`\$&`);
  return `[${escapedFilename}](${url})`;
}

function isVm0ArtifactUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  return (
    parsed.protocol === "https:" &&
    (parsed.hostname === "cdn.vm0.io" || parsed.hostname === "cdn.vm7.io") &&
    /^\/artifacts\/[^/]+\/[^/]+\/[^/]+$/.test(parsed.pathname)
  );
}

function appendChatThreadSegments(
  segments: InlinePromptLineSegment[],
  value: string,
): void {
  for (const segment of splitChatThreadMentionSegments(value)) {
    if (segment.type === "text") {
      if (segment.text.length > 0) {
        segments.push(segment);
      }
      continue;
    }
    segments.push({
      type: "thread",
      threadId: segment.threadId,
      title: segment.title,
    });
  }
}

function appendFileAndThreadSegments(
  segments: InlinePromptLineSegment[],
  value: string,
): void {
  let lastIndex = 0;
  for (const match of value.matchAll(MARKDOWN_LINK_PATTERN)) {
    const index = match.index ?? 0;
    const url = match[2] ?? "";
    if (!isVm0ArtifactUrl(url)) {
      continue;
    }
    appendChatThreadSegments(segments, value.slice(lastIndex, index));
    segments.push({
      type: "file",
      filename: (match[1] ?? "").replace(/\\([\\[\]])/g, "$1"),
      url,
    });
    lastIndex = index + match[0].length;
  }
  appendChatThreadSegments(segments, value.slice(lastIndex));
}

function appendTemplateFreeSegments(
  segments: InlinePromptLineSegment[],
  value: string,
): void {
  appendFileAndThreadSegments(segments, value);
}

export function splitInlinePromptLine(
  line: string,
): readonly InlinePromptLineSegment[] {
  const segments: InlinePromptLineSegment[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(INLINE_TEMPLATE_COMMENT_PATTERN)) {
    const index = match.index ?? 0;
    const templateType = match[1] ?? "";
    const selectionId = match[2] ?? "";
    const colorSystemId = match[3];
    const metadata = isTemplateType(templateType)
      ? {
          type: templateType,
          selectionId,
          ...(colorSystemId ? { colorSystemId } : {}),
        }
      : null;
    const resolved = metadata ? resolveInlineTemplate(metadata) : null;
    const beforeComment = line.slice(lastIndex, index);
    if (!resolved || !beforeComment.endsWith(resolved.title)) {
      appendTemplateFreeSegments(
        segments,
        line.slice(lastIndex, index + match[0].length),
      );
      lastIndex = index + match[0].length;
      continue;
    }
    appendTemplateFreeSegments(
      segments,
      beforeComment.slice(0, -resolved.title.length),
    );
    segments.push({ type: "template", template: resolved });
    lastIndex = index + match[0].length;
  }
  appendTemplateFreeSegments(segments, line.slice(lastIndex));
  return segments;
}
