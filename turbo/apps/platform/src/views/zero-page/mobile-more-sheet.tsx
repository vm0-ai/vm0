import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  IconChartLine,
  IconChevronRight,
  IconWorld,
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
  readonly icon: (props: { size?: number; stroke?: number }) => ReactNode;
  readonly iconBg: string;
  readonly iconColor: string;
  readonly label: string;
  readonly hint: string;
  readonly onSelect: () => void;
  readonly testId: string;
}

function SectionLink({
  icon: Icon,
  iconBg,
  iconColor,
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
      className="flex w-full items-center gap-3 px-3 py-2.5 rounded-xl bg-muted/50 hover:bg-muted text-left transition-colors"
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${iconBg}`}
      >
        <Icon size={18} stroke={1.6} />
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm font-semibold truncate ${iconColor}`}>
          {label}
        </span>
        <span className="block text-xs text-muted-foreground truncate">
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

  const goTo = (pathname: "/insights" | "/works") => {
    setOpen(false);
    navigate(pathname);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl max-h-[85vh] overflow-y-auto p-0"
        data-testid="mobile-more-sheet"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>More</SheetTitle>
          <SheetDescription>
            Insights and where Zero works.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 p-4 pb-8">
          <SectionLink
            icon={IconChartLine}
            iconBg="bg-[hsl(var(--gray-200))]"
            iconColor="text-foreground"
            label="Insights"
            hint="Activity charts and usage trends"
            testId="mobile-more-insights"
            onSelect={() => {
              goTo("/insights");
            }}
          />
          <SectionLink
            icon={IconWorld}
            iconBg="bg-[hsl(var(--gray-200))]"
            iconColor="text-foreground"
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
