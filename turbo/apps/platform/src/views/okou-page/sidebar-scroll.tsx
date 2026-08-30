import type {
  CSSProperties,
  FocusEventHandler,
  PointerEventHandler,
  ReactNode,
  UIEvent,
} from "react";
import { useGet, useSet } from "ccstate-react";
import type { SidebarChatThreadScrollSignals } from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";

/** Overlay scroll area: hides native scrollbar, renders a custom thin indicator. */
export function OverlayScrollArea({
  "aria-label": ariaLabel,
  className,
  children,
  onFocus,
  onPointerDownCapture,
  scrollSignals,
  style,
  "data-testid": dataTestId,
  tabIndex,
}: {
  "aria-label"?: string;
  className?: string;
  children: ReactNode;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
  scrollSignals: SidebarChatThreadScrollSignals;
  style?: CSSProperties;
  "data-testid"?: string;
  tabIndex?: number;
}) {
  const thumbStyleValue = useGet(scrollSignals.thumbStyle$);
  const setScrollMetrics = useSet(scrollSignals.setScrollMetrics$);
  const setViewportRef = useSet(scrollSignals.setScrollViewport$);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setScrollMetrics({ scrollTop, scrollHeight, clientHeight });
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
