"use client";

import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

function ContextMenu(props: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root {...props} />;
}

const ContextMenuTrigger = React.forwardRef<
  HTMLDivElement,
  ContextMenuPrimitive.Trigger.Props
>((props, ref) => {
  return <ContextMenuPrimitive.Trigger ref={ref} {...props} />;
});
ContextMenuTrigger.displayName = "ContextMenuTrigger";

export { ContextMenu, ContextMenuTrigger };
