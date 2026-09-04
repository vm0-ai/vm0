import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet } from "ccstate-react";
import type { ReactNode } from "react";

import { findHexRgbColors } from "../../lib/markdown/hex-rgb-color.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

function ColorPreview({ color }: { readonly color: string }) {
  return (
    <span
      aria-hidden="true"
      data-markdown-color-preview={color}
      className="ml-[0.3em] inline-block size-[0.875em] rounded-[3px] border border-foreground/60 align-[-0.1em]"
      style={{ backgroundColor: color }}
    />
  );
}

function useMarkdownColorPreviewEnabled(): boolean {
  return (
    useGet(featureSwitch$)[FeatureSwitchKey.MarkdownHexColorPreview] ?? false
  );
}

export function MarkdownColorPreview({ color }: { readonly color: string }) {
  return useMarkdownColorPreviewEnabled() ? (
    <ColorPreview color={color} />
  ) : null;
}

export function MarkdownTextWithColorPreviews({
  text,
}: {
  readonly text: string;
}) {
  const enabled = useMarkdownColorPreviewEnabled();
  if (!enabled) {
    return text;
  }
  const colors = findHexRgbColors(text);
  if (colors.length === 0) {
    return text;
  }

  const content: ReactNode[] = [];
  let offset = 0;
  for (const { color, start, end } of colors) {
    if (start > offset) {
      content.push(text.slice(offset, start));
    }
    content.push(color, <ColorPreview key={start} color={color} />);
    offset = end;
  }
  if (offset < text.length) {
    content.push(text.slice(offset));
  }
  return content;
}
