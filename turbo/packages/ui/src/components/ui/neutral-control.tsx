import { useRender } from "@base-ui/react/use-render";
import type { Ref } from "react";

import { cn } from "../../lib/utils";

export type NeutralControlProps = Omit<
  useRender.ComponentProps<"button">,
  "ref"
> & { ref?: Ref<HTMLElement> };

/** Neutral surface for native links and triggers; layout stays with the caller. */
export function NeutralControl({
  className,
  render,
  ref,
  ...props
}: NeutralControlProps) {
  return useRender({
    defaultTagName: "button",
    props: {
      "data-slot": "neutral-control",
      ...props,
      className: cn(
        "border border-control-border bg-control-surface text-foreground [&:hover]:bg-state-hover-overlay",
        className,
      ),
    },
    ref,
    render,
    state: {},
  });
}
