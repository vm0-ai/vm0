import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  IconChevronRight,
  IconLayoutGrid,
  IconSparkles,
} from "@tabler/icons-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@vm0/ui";
import {
  mobileMoreSheetOpen$,
  setMobileMoreSheetOpen$,
} from "../../signals/zero-page/zero-nav.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";

interface SectionLinkProps {
  readonly icon: (props: {
    size?: number;
    stroke?: number;
    className?: string;
  }) => ReactNode;
  readonly label: string;
  readonly hint: string;
  readonly onSelect: () => void;
  readonly testId: string;
}

function SectionLink({
  icon: Icon,
  label,
  hint,
  onSelect,
  testId,
}: SectionLinkProps) {
  // Lighter hairline-list treatment: no per-row card fill, no dividers,
  // smaller subtitle. Hover gets a subtle muted tint so the affordance
  // still reads on pointer devices.
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      className="flex w-full items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors hover:bg-muted/40 active:bg-muted/60"
    >
      <Icon size={22} stroke={1.6} className="shrink-0 text-muted-foreground" />
      <span className="flex-1 min-w-0">
        <span className="block text-[16px] font-semibold truncate text-foreground">
          {label}
        </span>
        <span className="block text-[14px] text-muted-foreground truncate">
          {hint}
        </span>
      </span>
      <IconChevronRight
        size={16}
        stroke={1.6}
        className="shrink-0 text-muted-foreground/60"
      />
    </button>
  );
}

export function MobileMoreSheet() {
  const open = useGet(mobileMoreSheetOpen$);
  const setOpen = useSet(setMobileMoreSheetOpen$);
  const navigate = useSet(detachedNavigateTo$);

  const goTo = (pathname: "/insights" | "/works") => {
    setOpen(false);
    navigate(pathname);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="bottom"
        // hideClose: the default close-X sits at top-4/right-4 and overlaps
        // the first row's chevron. The grabber bar + tap-overlay-to-close
        // cover the same affordance without the visual collision.
        hideClose
        className="rounded-t-2xl max-h-[85vh] overflow-y-auto p-0 shadow-[0_-12px_32px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_-16px_48px_-12px_rgba(0,0,0,0.55)]"
        data-testid="mobile-more-sheet"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>More</SheetTitle>
          <SheetDescription>
            Insights and where Zero works.
          </SheetDescription>
        </SheetHeader>
        <div className="flex justify-center pt-2.5">
          <span
            aria-hidden
            className="h-1 w-10 rounded-full bg-[hsl(var(--gray-300))]"
          />
        </div>
        <div className="flex flex-col gap-2 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <SectionLink
            icon={IconSparkles}
            label="Insights"
            hint="Activity charts and usage trends"
            testId="mobile-more-insights"
            onSelect={() => {
              goTo("/insights");
            }}
          />
          <SectionLink
            icon={IconLayoutGrid}
            label="Slack & Telegram"
            hint="Where Zero works"
            testId="mobile-more-works"
            onSelect={() => {
              goTo("/works");
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
