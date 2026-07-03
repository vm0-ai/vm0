import type { CSSProperties, ReactNode } from "react";
import {
  matchShortcut,
  isEditableTarget,
  type KeyboardEventLike,
} from "./keyboard-shortcuts";

export function Shortcut({
  binding,
  children,
  className,
  style,
}: {
  binding: Record<string, (e: KeyboardEventLike) => void>;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className}
      style={style}
      onKeyDown={(e) => {
        if (isEditableTarget(e.target)) {
          return;
        }
        for (const [shortcut, callback] of Object.entries(binding)) {
          if (matchShortcut(shortcut, e)) {
            e.preventDefault();
            callback(e);
            return;
          }
        }
      }}
    >
      {children}
    </div>
  );
}
