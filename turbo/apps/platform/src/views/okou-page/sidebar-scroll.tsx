import type {
  CSSProperties,
  FocusEventHandler,
  PointerEventHandler,
  ReactNode,
  UIEvent,
} from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { useGet, useSet } from "ccstate-react";
import type {
  SidebarChatThreadScrollMetrics,
  SidebarChatThreadScrollSignals,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import { baseUiSidebarScrollAreaEnabled$ } from "../../signals/external/feature-switch.ts";

interface OverlayScrollAreaProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly onFocus?: FocusEventHandler<HTMLDivElement>;
  readonly onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
  readonly scrollSignals: SidebarChatThreadScrollSignals;
  readonly style?: CSSProperties;
  readonly "data-testid"?: string;
  readonly tabIndex?: number;
}

function updateScrollMetrics(
  event: UIEvent<HTMLDivElement>,
  setScrollMetrics: (metrics: SidebarChatThreadScrollMetrics) => void,
): void {
  const element = event.currentTarget;
  setScrollMetrics({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  });
}

/** Existing scroll area retained unchanged behind the disabled switch. */
function LegacyOverlayScrollArea({
  "aria-label": ariaLabel,
  className,
  children,
  onFocus,
  onPointerDownCapture,
  scrollSignals,
  style,
  "data-testid": dataTestId,
  tabIndex,
}: OverlayScrollAreaProps) {
  const thumbStyleValue = useGet(scrollSignals.thumbStyle$);
  const setScrollMetrics = useSet(scrollSignals.setScrollMetrics$);
  const setViewportRef = useSet(scrollSignals.setScrollViewport$);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    updateScrollMetrics(event, setScrollMetrics);
  };

  return (
    <div className={`group/sidebar-scroll relative ${className ?? ""}`}>
      <div
        ref={setViewportRef}
        className="h-full overflow-y-auto overflow-x-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={style}
        onFocus={onFocus}
        onPointerDownCapture={onPointerDownCapture}
        onScroll={handleScroll}
        tabIndex={tabIndex}
        role={ariaLabel ? "region" : undefined}
        aria-label={ariaLabel}
        data-testid={dataTestId}
      >
        {children}
      </div>
      <div
        className={`absolute -right-2 top-0 bottom-0 w-[6px] pointer-events-none opacity-0 transition-opacity duration-150 ${
          thumbStyleValue.visible
            ? "group-hover/sidebar-scroll:opacity-100"
            : ""
        }`}
        aria-hidden="true"
      >
        <div
          className="absolute right-0 w-[5px] rounded-full bg-foreground/15"
          style={{ top: thumbStyleValue.top, height: thumbStyleValue.height }}
        />
      </div>
    </div>
  );
}

function BaseUiOverlayScrollArea({
  "aria-label": ariaLabel,
  className,
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
    updateScrollMetrics(event, setScrollMetrics);
  };

  return (
    <ScrollArea.Root
      className={`group/sidebar-scroll relative ${className ?? ""}`}
    >
      <ScrollArea.Viewport
        ref={setViewportRef}
        className="h-full overflow-x-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ ...style, overflowX: "hidden", overflowY: "auto" }}
        onFocus={onFocus}
        onPointerDownCapture={onPointerDownCapture}
        onScroll={handleScroll}
        tabIndex={tabIndex ?? -1}
        role={ariaLabel ? "region" : undefined}
        aria-label={ariaLabel}
        data-testid={dataTestId}
      >
        <ScrollArea.Content style={{ minWidth: "100%" }}>
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar
        className="w-3 px-[3.5px] opacity-0 transition-opacity duration-150 data-hovering:opacity-100 data-scrolling:opacity-100"
        style={{
          insetInlineEnd: "-0.5rem",
          paddingBlockEnd: 0,
          paddingBlockStart: 0,
        }}
        data-testid="sidebar-scrollbar"
      >
        <ScrollArea.Thumb
          className="w-[5px] rounded-full bg-foreground/15"
          style={{ marginBlockEnd: 0, marginBlockStart: 0 }}
          data-testid="sidebar-scrollbar-thumb"
        />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}

/** Overlay scroll area with a feature-gated draggable Base UI scrollbar. */
export function OverlayScrollArea(props: OverlayScrollAreaProps) {
  const baseUiEnabled = useGet(baseUiSidebarScrollAreaEnabled$);
  if (baseUiEnabled) {
    return <BaseUiOverlayScrollArea {...props} />;
  }
  return <LegacyOverlayScrollArea {...props} />;
}
