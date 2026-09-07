import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { Button } from "@okouai/ui";
import { useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

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
const STYLE_GROUPS = [...STYLE_TAGS, "other"] as const;

function styleGroup(style: IntroVideoStyle) {
  // Keep one card per style even when the provider assigns multiple tags.
  return (
    STYLE_TAGS.find((tag) => {
      return style.tags.includes(tag);
    }) ?? "other"
  );
}

function styleGroupId(tag: string) {
  return `intro-video-style-group-${tag}`;
}

export function IntroVideoStyleTagNavigation() {
  const { t } = useTranslation();
  const catalog = useLoadable(introVideoStyleGallerySignals.catalog$);
  if (catalog.state !== "hasData") {
    return null;
  }
  const tags = STYLE_GROUPS.filter((tag) => {
    return catalog.data.some((style) => {
      return styleGroup(style) === tag;
    });
  });
  if (tags.length === 0) {
    return null;
  }
  return (
    <nav
      aria-label={t(($) => {
        return $.chat.introVideo.style.browseGroups;
      })}
      className="flex shrink-0 flex-wrap gap-2 border-y border-border px-3 py-3 sm:px-6"
    >
      {tags.map((tag) => {
        const id = styleGroupId(tag);
        return (
          <Button
            key={tag}
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full border-border text-xs"
            aria-controls={id}
            onClick={() => {
              document.getElementById(id)?.scrollIntoView({ block: "start" });
            }}
          >
            {tag === "other"
              ? t(($) => {
                  return $.chat.introVideo.style.groups.other;
                })
              : tag}
          </Button>
        );
      })}
    </nav>
  );
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
  const { t } = useTranslation();
  const setGalleryRef = useSet(introVideoStyleGallerySignals.setGalleryRef$);
  const labels = {
    cinematic: t(($) => {
      return $.chat.introVideo.style.groups.cinematic;
    }),
    handmade: t(($) => {
      return $.chat.introVideo.style.groups.handmade;
    }),
    "retro-tech": t(($) => {
      return $.chat.introVideo.style.groups["retro-tech"];
    }),
    "pop-culture": t(($) => {
      return $.chat.introVideo.style.groups["pop-culture"];
    }),
    print: t(($) => {
      return $.chat.introVideo.style.groups.print;
    }),
    "iconic-artist": t(($) => {
      return $.chat.introVideo.style.groups["iconic-artist"];
    }),
    other: t(($) => {
      return $.chat.introVideo.style.groups.other;
    }),
  };
  return (
    <div className="grid gap-6" ref={setGalleryRef}>
      {STYLE_GROUPS.map((tag) => {
        const matches = styles.filter((style) => {
          return styleGroup(style) === tag;
        });
        if (matches.length === 0) {
          return null;
        }
        const label = labels[tag];
        return (
          <section
            key={tag}
            id={styleGroupId(tag)}
            aria-label={label}
            className="grid scroll-mt-3 gap-3 sm:scroll-mt-6"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="text-sm font-medium text-foreground">
                {label} · {matches.length}
              </h3>
              {tag !== "other" ? (
                <span className="text-xs text-muted-foreground">{tag}</span>
              ) : null}
            </div>
            <div className="grid grid-cols-2 items-start gap-2.5 sm:grid-cols-3 sm:gap-3">
              {matches.map((style) => {
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
          </section>
        );
      })}
    </div>
  );
}
