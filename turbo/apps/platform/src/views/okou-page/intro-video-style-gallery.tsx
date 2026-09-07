import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { useSet } from "ccstate-react";

import { introVideoStyleGallerySignals } from "../../signals/okou-page/intro-video-style-gallery.ts";
import { IntroVideoStyleCard } from "./intro-video-style-card.tsx";

const STYLE_TAGS = [
  "cinematic",
  "handmade",
  "retro-tech",
  "pop-culture",
  "print",
  "iconic-artist",
] as const;

function styleRank(style: IntroVideoStyle) {
  // Keep related styles adjacent even when the provider assigns multiple tags.
  const index = STYLE_TAGS.findIndex((tag) => {
    return style.tags.includes(tag);
  });
  return index === -1 ? STYLE_TAGS.length : index;
}

export function IntroVideoStyleGallery({
  styles,
  selectedStyleId,
  onSelect,
}: {
  readonly styles: readonly IntroVideoStyle[];
  readonly selectedStyleId: string | undefined;
  readonly onSelect: (style: IntroVideoStyle) => void;
}) {
  const setGalleryRef = useSet(introVideoStyleGallerySignals.setGalleryRef$);
  const ordered = [...styles].sort((left, right) => {
    return styleRank(left) - styleRank(right);
  });
  return (
    <div
      className="grid grid-cols-2 items-start gap-2.5 sm:grid-cols-3 sm:gap-3"
      ref={setGalleryRef}
    >
      {ordered.map((style) => {
        return (
          <IntroVideoStyleCard
            key={style.id}
            style={style}
            selected={selectedStyleId === style.id}
            onSelect={() => {
              onSelect(style);
            }}
          />
        );
      })}
    </div>
  );
}
