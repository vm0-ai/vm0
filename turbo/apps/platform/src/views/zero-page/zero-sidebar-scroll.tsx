import type {
  CSSProperties,
  FocusEventHandler,
  PointerEventHandler,
  ReactNode,
  UIEvent,
} from "react";
import { useGet, useSet } from "ccstate-react";
import {
  thumbStyle$,
  setThumbStyle$,
  setOverlayScrollMetrics$,
  setOverlayScrollViewport$,
} from "../../signals/zero-page/zero-sidebar-state.ts";

/** Overlay scroll area: hides native scrollbar, renders a custom thin indicator. */
export function OverlayScrollArea({
  "aria-label": ariaLabel,
  className,
  children,
  onFocus,
  onPointerDownCapture,
  onScroll,
  style,
  "data-testid": dataTestId,
  tabIndex,
}: {
  "aria-label"?: string;
  className?: string;
  children: ReactNode;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  onPointerDownCapture?: PointerEventHandler<HTMLDivElement>;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  style?: CSSProperties;
  "data-testid"?: string;
  tabIndex?: number;
}) {
  const thumbStyleValue = useGet(thumbStyle$);
  const setThumbStyleFn = useSet(setThumbStyle$);
  const setOverlayScrollMetricsFn = useSet(setOverlayScrollMetrics$);
  const setViewportRef = useSet(setOverlayScrollViewport$);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    onScroll?.(e);
    const el = e.currentTarget;
    const { scrollTop, scrollHeight, clientHeight } = el;
    setOverlayScrollMetricsFn({ scrollTop, scrollHeight, clientHeight });
    if (scrollHeight <= clientHeight) {
      setThumbStyleFn({
        top: thumbStyleValue.top,
        height: thumbStyleValue.height,
        visible: false,
      });
      return;
    }
    const ratio = clientHeight / scrollHeight;
    const thumbH = Math.max(ratio * clientHeight, 24);
    const maxTop = clientHeight - thumbH;
    const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    setThumbStyleFn({ top, height: thumbH, visible: true });
  };

  return (
    <div className={`group/sidebar-scroll relative ${className ?? ""}`}>
      <div
        ref={setViewportRef}
        className="h-full overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={style}
        onFocus={onFocus}
        onPointerDownCapture={onPointerDownCapture}
        onScroll={handleScroll}
        tabIndex={tabIndex}
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
