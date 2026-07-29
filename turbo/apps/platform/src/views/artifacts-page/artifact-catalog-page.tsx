import type { UIEvent as ReactUIEvent } from "react";
import type {
  ArtifactCatalogKind,
  ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import {
  IconAlertTriangle,
  IconFile,
  IconPhoto,
  IconPresentationAnalytics,
  IconVideo,
  IconWorld,
} from "@tabler/icons-react";
import { r2ImageTransformUrl } from "@vm0/core";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";
import { Alert, AlertDescription } from "@vm0/ui/components/ui/alert";
import { useTranslation } from "react-i18next";

import {
  artifactCatalog$,
  loadMoreArtifactCatalog$,
  openArtifact$,
  selectedArtifactCatalogKind$,
  setArtifactCatalogKind$,
} from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { lightboxUrl$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import { AttachmentLightbox } from "../zero-page/zero-attachment-chips.tsx";
import { ArtifactThumbnailImage } from "../zero-page/zero-artifact-thumbnail.tsx";
import { emptyArtifactImg } from "../zero-page/platform-assets.ts";
import {
  FilePreviewIcon,
  getFilePreviewAccentClass,
} from "../zero-page/zero-file-preview-icon.tsx";

// Distance from the bottom of the scroll container at which the next page is
// requested. The signal layer deduplicates repeated requests for one cursor.
const ARTIFACT_AUTO_LOAD_VIEWPORT_COUNT = 2;
const ARTIFACT_GRID_MIN_CARD_WIDTH_PX = 292;
const ARTIFACT_CARD_THUMBNAIL_WIDTH_PX = 640;

const ARTIFACT_KIND_OPTIONS: readonly ArtifactCatalogKind[] = [
  "presentation",
  "hosted-site",
  "image",
  "video",
  "file",
];

function ArtifactKindIcon({ kind }: { readonly kind: ArtifactCatalogKind }) {
  const { t } = useTranslation();
  const icon =
    kind === "presentation" ? (
      <IconPresentationAnalytics size={16} stroke={1.7} />
    ) : kind === "hosted-site" ? (
      <IconWorld size={16} stroke={1.7} />
    ) : kind === "image" ? (
      <IconPhoto size={16} stroke={1.7} />
    ) : kind === "video" ? (
      <IconVideo size={16} stroke={1.7} />
    ) : (
      <IconFile size={16} stroke={1.7} />
    );
  const kindLabel =
    kind === "presentation"
      ? t(($) => {
          return $.artifacts.kinds.presentation;
        })
      : kind === "hosted-site"
        ? t(($) => {
            return $.artifacts.kinds.hostedSite;
          })
        : kind === "image"
          ? t(($) => {
              return $.artifacts.kinds.image;
            })
          : kind === "video"
            ? t(($) => {
                return $.artifacts.kinds.video;
              })
            : t(($) => {
                return $.artifacts.kinds.file;
              });

  return (
    <span
      aria-label={t(
        ($) => {
          return $.artifacts.catalog.kindIcon;
        },
        { kind: kindLabel },
      )}
      data-testid={`artifact-catalog-kind-icon-${kind}`}
      className="pointer-events-none absolute left-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-sm ring-1 ring-white/15"
    >
      {icon}
    </span>
  );
}

function ArtifactCatalogFallbackPreview({
  artifact,
}: {
  readonly artifact: ArtifactSummary;
}) {
  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br p-6",
        getFilePreviewAccentClass(artifact.title),
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.45),transparent_55%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%)]" />
      <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/10 to-transparent" />
      <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-foreground/10 bg-background/90 shadow-sm transition-transform duration-200 group-hover:scale-105">
        <FilePreviewIcon
          filename={artifact.title}
          testId="artifact-catalog-file-preview-icon"
        />
      </div>
    </div>
  );
}

function ArtifactCatalogCard({
  artifact,
  onOpen,
}: {
  readonly artifact: ArtifactSummary;
  readonly onOpen: (artifactId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={t(
        ($) => {
          return $.artifacts.catalog.cardPreview;
        },
        {
          title: artifact.title,
        },
      )}
      onClick={() => {
        onOpen(artifact.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        onOpen(artifact.id);
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div
        data-testid="artifact-catalog-card-preview"
        className="relative aspect-[16/10] w-full shrink-0 overflow-hidden bg-background"
      >
        {artifact.thumbnail ? (
          <ArtifactThumbnailImage
            src={r2ImageTransformUrl(artifact.thumbnail.url, {
              width: ARTIFACT_CARD_THUMBNAIL_WIDTH_PX,
              fit: "scale-down",
            })}
            className="h-full w-full object-cover"
            fallback={<ArtifactCatalogFallbackPreview artifact={artifact} />}
            testId="artifact-catalog-thumbnail"
          />
        ) : artifact.kind === "file" ? (
          <ArtifactCatalogFallbackPreview artifact={artifact} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted/30" />
        )}
        <ArtifactKindIcon kind={artifact.kind} />
      </div>
      <div className="flex h-16 min-w-0 shrink-0 items-center border-t border-border p-3">
        <h2
          title={artifact.title}
          className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground"
        >
          {artifact.title}
        </h2>
      </div>
    </article>
  );
}

export function ArtifactCatalogGrid({
  artifacts,
  onOpen,
}: {
  readonly artifacts: readonly ArtifactSummary[];
  readonly onOpen: (artifactId: string) => void;
}) {
  return (
    <div
      data-testid="artifact-catalog-grid"
      className="grid gap-3"
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${String(ARTIFACT_GRID_MIN_CARD_WIDTH_PX)}px), 1fr))`,
      }}
    >
      {artifacts.map((artifact) => {
        return (
          <ArtifactCatalogCard
            key={artifact.id}
            artifact={artifact}
            onOpen={onOpen}
          />
        );
      })}
    </div>
  );
}

export function ArtifactCatalogSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className="grid gap-3"
      aria-label={t(($) => {
        return $.artifacts.catalog.loading;
      })}
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${String(ARTIFACT_GRID_MIN_CARD_WIDTH_PX)}px), 1fr))`,
      }}
    >
      {Array.from({ length: 8 }, (_, index) => {
        return (
          <div
            key={index}
            className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
          >
            <div className="aspect-[16/10] w-full shrink-0 bg-muted/30" />
            <div className="flex h-16 shrink-0 items-center p-3">
              <div className="h-4 w-3/4 rounded bg-muted/60" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ArtifactCatalogError() {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive">
      <IconAlertTriangle size={16} stroke={1.5} aria-hidden />
      <AlertDescription>
        {t(($) => {
          return $.artifacts.catalog.error;
        })}
      </AlertDescription>
    </Alert>
  );
}

export function ArtifactCatalogEmpty() {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
      <img
        src={emptyArtifactImg}
        alt=""
        role="presentation"
        loading="lazy"
        className="mx-auto h-24 w-24 object-contain opacity-80"
      />
      <h2 className="mt-4 text-sm font-medium text-foreground">
        {t(($) => {
          return $.artifacts.catalog.emptyTitle;
        })}
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        {t(($) => {
          return $.artifacts.catalog.emptyDescription;
        })}
      </p>
    </div>
  );
}

function ArtifactCatalogKindFilter({
  selectedKind,
  onKindChange,
}: {
  readonly selectedKind: ArtifactCatalogKind | null;
  readonly onKindChange: (value: ArtifactCatalogKind | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label={t(($) => {
        return $.artifacts.catalog.filters.label;
      })}
    >
      {ARTIFACT_KIND_OPTIONS.map((kind) => {
        const selected = kind === selectedKind;
        const label =
          kind === "presentation"
            ? t(($) => {
                return $.artifacts.catalog.filters.presentation;
              })
            : kind === "hosted-site"
              ? t(($) => {
                  return $.artifacts.catalog.filters.website;
                })
              : kind === "image"
                ? t(($) => {
                    return $.artifacts.catalog.filters.image;
                  })
                : kind === "video"
                  ? t(($) => {
                      return $.artifacts.catalog.filters.video;
                    })
                  : t(($) => {
                      return $.artifacts.catalog.filters.file;
                    });
        const ariaLabel =
          kind === "presentation"
            ? t(($) => {
                return $.artifacts.catalog.filters.presentationAria;
              })
            : kind === "hosted-site"
              ? t(($) => {
                  return $.artifacts.catalog.filters.websiteAria;
                })
              : kind === "image"
                ? t(($) => {
                    return $.artifacts.catalog.filters.imageAria;
                  })
                : kind === "video"
                  ? t(($) => {
                      return $.artifacts.catalog.filters.videoAria;
                    })
                  : t(($) => {
                      return $.artifacts.catalog.filters.fileAria;
                    });
        return (
          <button
            key={kind}
            type="button"
            aria-label={ariaLabel}
            aria-pressed={selected}
            onClick={() => {
              onKindChange(kind);
            }}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors",
              selected
                ? "bg-muted text-foreground"
                : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function ArtifactCatalogPage() {
  const { t } = useTranslation();
  const selectedKind = useGet(selectedArtifactCatalogKind$);
  const setKind = useSet(setArtifactCatalogKind$);
  const openArtifact = useSet(openArtifact$);
  const loadMore = useSet(loadMoreArtifactCatalog$);
  const pageSignal = useGet(pageSignal$);
  const lightboxUrl = useGet(lightboxUrl$);
  const catalog = useLoadable(artifactCatalog$);
  const artifacts = catalog.state === "hasData" ? catalog.data.artifacts : [];
  const hasMore =
    catalog.state === "hasData" && catalog.data.nextCursor !== null;

  const handleScroll = (event: ReactUIEvent<HTMLElement>) => {
    if (!hasMore) {
      return;
    }
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const autoLoadThreshold =
      viewport.clientHeight * ARTIFACT_AUTO_LOAD_VIEWPORT_COUNT;
    if (distanceFromBottom > autoLoadThreshold) {
      return;
    }
    detach(loadMore(pageSignal), Reason.DomCallback, "artifact catalog paging");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {lightboxUrl && <AttachmentLightbox />}
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              {t(($) => {
                return $.artifacts.title;
              })}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t(($) => {
                return $.artifacts.catalog.description;
              })}
            </p>
          </div>
        </div>
      </header>

      <main
        onScroll={handleScroll}
        className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6 [scrollbar-gutter:stable]"
      >
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
          <ArtifactCatalogKindFilter
            selectedKind={selectedKind}
            onKindChange={setKind}
          />
          {catalog.state === "loading" ? (
            <ArtifactCatalogSkeleton />
          ) : catalog.state === "hasError" ? (
            <ArtifactCatalogError />
          ) : artifacts.length === 0 ? (
            <ArtifactCatalogEmpty />
          ) : (
            <ArtifactCatalogGrid
              artifacts={artifacts}
              onOpen={(artifactId) => {
                detach(
                  openArtifact(artifactId, pageSignal),
                  Reason.DomCallback,
                  "artifact catalog open",
                );
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
