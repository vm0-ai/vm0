import { Button } from "@okouai/ui";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export function IntroVideoCatalogPagination({
  hasNext,
  loading,
  error,
  onLoadMore,
}: {
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly error: boolean;
  readonly onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  if (!hasNext) {
    return null;
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-3" role="status">
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.introVideo.catalog.error;
          })}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onLoadMore}>
          {t(($) => {
            return $.chat.introVideo.catalog.retry;
          })}
        </Button>
      </div>
    );
  }
  if (loading) {
    return (
      <div
        className="flex justify-center py-3 text-muted-foreground"
        role="status"
      >
        <Loader2 className="animate-spin" size={18} aria-hidden="true" />
        <span className="sr-only">
          {t(($) => {
            return $.chat.introVideo.catalog.loading;
          })}
        </span>
      </div>
    );
  }
  return (
    <div
      data-intro-video-catalog-sentinel=""
      aria-hidden="true"
      className="h-px"
      ref={(node) => {
        if (!node) {
          return;
        }
        const observer = new IntersectionObserver(
          (entries) => {
            if (
              entries.some((entry) => {
                return entry.isIntersecting;
              })
            ) {
              observer.disconnect();
              onLoadMore();
            }
          },
          {
            root: node.closest("[data-intro-video-catalog-scroll]"),
            rootMargin: "0px 0px 320px 0px",
          },
        );
        observer.observe(node);
        return () => {
          observer.disconnect();
        };
      }}
    />
  );
}
