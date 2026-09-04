"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "../../lib/utils";

const Tabs = React.forwardRef<HTMLDivElement, TabsPrimitive.Root.Props>(
  ({ className, orientation = "horizontal", ...props }, ref) => {
    return (
      <TabsPrimitive.Root
        ref={ref}
        data-slot="tabs"
        data-orientation={orientation}
        orientation={orientation}
        className={cn(className)}
        {...props}
      />
    );
  },
);
Tabs.displayName = "Tabs";

const TabsList = React.forwardRef<HTMLDivElement, TabsPrimitive.List.Props>(
  ({ className, ...props }, ref) => {
    return (
      <TabsPrimitive.List
        ref={ref}
        data-slot="tabs-list"
        className={cn(
          // Geometry is shared with SegmentControl: the two patterns differ in
          // semantics (navigating panels vs picking a value), not in looks, and
          // letting them drift is what left the product with two skins.
          "inline-flex h-9 items-center justify-center gap-0.5 rounded-lg bg-segment-track p-0.5 text-muted-foreground",
          className,
        )}
        {...props}
      />
    );
  },
);
TabsList.displayName = "TabsList";

const TabsTrigger = React.forwardRef<HTMLElement, TabsPrimitive.Tab.Props>(
  ({ className, ...props }, ref) => {
    return (
      <TabsPrimitive.Tab
        ref={ref}
        data-slot="tabs-trigger"
        className={cn(
          "inline-flex h-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground outline-none transition-colors not-data-active:hover:bg-state-hover not-data-active:hover:text-foreground data-active:bg-segment-selected data-active:text-foreground data-active:shadow-segment-selected disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
          className,
        )}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

const TabsContent = React.forwardRef<HTMLDivElement, TabsPrimitive.Panel.Props>(
  ({ className, ...props }, ref) => {
    return (
      <TabsPrimitive.Panel
        ref={ref}
        data-slot="tabs-content"
        className={cn("outline-none", className)}
        {...props}
      />
    );
  },
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
