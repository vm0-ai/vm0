import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  thumbStyle$,
  setThumbStyle$,
  hovering$,
  setHovering$,
} from "../../signals/zero-page/zero-sidebar-state.ts";

/** Overlay scroll area: hides native scrollbar, renders a custom thin indicator. */
export function OverlayScrollArea({
  className,
  children,
  onScroll,
  style,
  "data-testid": dataTestId,
}: {
  className?: string;
  children: ReactNode;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  style?: React.CSSProperties;
  "data-testid"?: string;
}) {
  const thumbStyleValue = useGet(thumbStyle$);
  const setThumbStyleFn = useSet(setThumbStyle$);
  const hovering = useGet(hovering$);
  const setHoveringFn = useSet(setHovering$);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    onScroll?.(e);
    const el = e.currentTarget;
    const { scrollTop, scrollHeight, clientHeight } = el;
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

  const showThumb = thumbStyleValue.visible && hovering;

  return (
    <div
      className={`relative ${className ?? ""}`}
      onMouseEnter={() => {
        return setHoveringFn(true);
      }}
      onMouseLeave={() => {
        return setHoveringFn(false);
      }}
    >
      <div
        className="h-full overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={style}
        onScroll={handleScroll}
        data-testid={dataTestId}
      >
        {children}
      </div>
      <div
        className="absolute -right-2 top-0 bottom-0 w-[6px] pointer-events-none"
        aria-hidden="true"
        style={{ opacity: showThumb ? 1 : 0, transition: "opacity 150ms" }}
      >
        <div
          className="absolute right-0 w-[5px] rounded-full bg-foreground/15"
          style={{ top: thumbStyleValue.top, height: thumbStyleValue.height }}
        />
      </div>
    </div>
  );
}
