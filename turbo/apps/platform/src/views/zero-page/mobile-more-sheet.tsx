import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  IconChevronRight,
  IconLayoutGrid,
  IconSparkles,
  IconUserCircle,
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
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      className="flex w-full items-center gap-3 px-3 py-3 rounded-xl bg-muted/40 hover:bg-muted text-left transition-colors"
    >
      <Icon size={22} stroke={1.6} className="shrink-0 text-foreground" />
      <span className="flex-1 min-w-0">
        <span className="block text-[17px] font-semibold truncate text-foreground">
          {label}
        </span>
        <span className="block text-[15px] text-muted-foreground truncate">
          {hint}
        </span>
      </span>
      <IconChevronRight
        size={16}
        stroke={1.6}
        className="shrink-0 text-muted-foreground"
      />
    </button>
  );
}

export function MobileMoreSheet() {
  const open = useGet(mobileMoreSheetOpen$);
  const setOpen = useSet(setMobileMoreSheetOpen$);
  const navigate = useSet(detachedNavigateTo$);

  const goTo = (pathname: "/insights" | "/works" | "/account") => {
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
        className="rounded-t-2xl min-h-[45vh] max-h-[85vh] overflow-y-auto p-0 shadow-[0_-12px_32px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_-16px_48px_-12px_rgba(0,0,0,0.55)]"
        data-testid="mobile-more-sheet"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>More</SheetTitle>
          <SheetDescription>
            Insights, where Zero works, and account settings.
          </SheetDescription>
        </SheetHeader>
        <div className="flex justify-center pt-2.5">
          <span
            aria-hidden
            className="h-1 w-10 rounded-full bg-[hsl(var(--gray-300))]"
          />
        </div>
        <div className="flex flex-col gap-2 p-4 pb-10">
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
          <SectionLink
            icon={IconUserCircle}
            label="Account"
            hint="Profile, theme, preferences"
            testId="mobile-more-account"
            onSelect={() => {
              goTo("/account");
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
