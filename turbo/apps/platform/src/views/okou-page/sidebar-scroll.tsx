import type {
  CSSProperties,
  FocusEventHandler,
  PointerEventHandler,
  ReactNode,
  UIEvent,
} from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { useSet } from "ccstate-react";
import type { SidebarChatThreadScrollSignals } from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";

interface OverlayScrollAreaProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly children: ReactNode;
  readonly onFocus?: FocusEventHandler<HTMLDivElement>;
  readonly onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
  readonly scrollSignals: SidebarChatThreadScrollSignals;
  readonly style?: CSSProperties;
  readonly "data-testid"?: string;
  readonly tabIndex?: number;
}

/** Overlay scroll area with a draggable Base UI scrollbar. */
export function OverlayScrollArea({
  "aria-label": ariaLabel,
  className,
  contentClassName,
  children,
  onFocus,
  onPointerDownCapture,
  scrollSignals,
  style,
  "data-testid": dataTestId,
  tabIndex,
}: OverlayScrollAreaProps) {
  const setScrollMetrics = useSet(scrollSignals.setScrollMetrics$);
  const setViewportRef = useSet(scrollSignals.setScrollViewport$);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setScrollMetrics({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
    });
  };

  return (
    <ScrollArea.Root className={className}>
      <ScrollArea.Viewport
        ref={setViewportRef}
        className="h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={style}
        onFocus={onFocus}
        onPointerDownCapture={onPointerDownCapture}
        onScroll={handleScroll}
        tabIndex={tabIndex ?? -1}
        role={ariaLabel ? "region" : undefined}
        aria-label={ariaLabel}
        data-testid={dataTestId}
      >
        <ScrollArea.Content className={contentClassName}>
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      {/* The track stays wide enough to grab; `justify-end` keeps the thumb
          itself against the viewport's edge, clear of the trailing menu button
          on the rows beside the workspace card. */}
      <ScrollArea.Scrollbar
        className="m-px flex w-3 justify-end opacity-0 transition-opacity duration-150 data-hovering:opacity-100 data-scrolling:opacity-100 data-scrolling:duration-0"
        data-testid="sidebar-scrollbar"
      >
        <ScrollArea.Thumb
          className="w-[5px] rounded-full bg-foreground/15"
          data-testid="sidebar-scrollbar-thumb"
        />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
