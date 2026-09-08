import type { IntroVideoStyle } from "@okouai/api-contracts/contracts/intro-video-presenter";
import { cn } from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
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

function useGroupLabels() {
  const { t } = useTranslation();
  return {
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
}

export function IntroVideoStyleGroupNav() {
  const { t } = useTranslation();
  const labels = useGroupLabels();
  const activeGroup = useGet(introVideoStyleGallerySignals.activeGroup$);
  const catalog = useLoadable(introVideoStyleGallerySignals.catalog$);
  if (catalog.state !== "hasData") {
    return null;
  }
  const groups = STYLE_GROUPS.map((tag) => {
    return {
      tag,
      count: catalog.data.filter((style) => {
        return styleGroup(style) === tag;
      }).length,
    };
  }).filter((group) => {
    return group.count > 0;
  });
  if (groups.length === 0) {
    return null;
  }
  const heading = t(($) => {
    return $.chat.introVideo.style.browseGroups;
  });
  return (
    <nav
      aria-label={heading}
      className="flex min-w-0 flex-row gap-2 sm:flex-col sm:gap-0.5"
    >
      <h3 className="hidden px-2.5 py-1 text-xs font-medium text-muted-foreground sm:block">
        {heading}
      </h3>
      {groups.map((group) => {
        const id = styleGroupId(group.tag);
        const active = activeGroup === group.tag;
        return (
          <button
            key={group.tag}
            type="button"
            aria-controls={id}
            aria-current={active ? "true" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-full sm:justify-between sm:border-transparent",
              active
                ? "border-border bg-muted font-medium text-foreground"
                : "border-border text-foreground sm:bg-transparent",
            )}
            onClick={() => {
              document.getElementById(id)?.scrollIntoView({ block: "start" });
            }}
          >
            <span className="truncate">{labels[group.tag]}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {group.count}
            </span>
          </button>
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
  const labels = useGroupLabels();
  const setGalleryRef = useSet(introVideoStyleGallerySignals.setGalleryRef$);
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
            data-intro-video-style-group={tag}
            className="grid scroll-mt-3 gap-3 sm:scroll-mt-6"
          >
            <h3 className="text-sm font-medium text-foreground">
              {label} · {matches.length}
            </h3>
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
