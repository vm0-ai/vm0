import * as React from "react";

type InteractionType = "" | "keyboard" | "mouse" | "pen" | "touch";

type AutoFocusValue =
  | boolean
  | React.RefObject<HTMLElement | null>
  | ((interactionType: InteractionType) => boolean | HTMLElement | null | void);

export type LegacyAutoFocusHandler = (event: Event) => void;

export function asChildRender(children: React.ReactNode): React.ReactElement {
  if (!React.isValidElement(children)) {
    throw new Error("asChild requires exactly one React element");
  }
  return children;
}

export function withLegacyAutoFocus(
  value: AutoFocusValue | undefined,
  handler: LegacyAutoFocusHandler | undefined,
  eventName: "closeAutoFocus" | "openAutoFocus",
): AutoFocusValue | undefined {
  if (!handler) {
    return value;
  }

  return (interactionType) => {
    const event = new Event(eventName, { cancelable: true });
    handler(event);
    if (event.defaultPrevented) {
      return false;
    }
    if (typeof value === "function") {
      return value(interactionType);
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (value) {
      return value.current;
    }
    return true;
  };
}
