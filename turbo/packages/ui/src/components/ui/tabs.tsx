import { createContext, useContext, useRef } from "react";
import { cn } from "../../lib/utils";

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | undefined>(undefined);

function useTabsContext() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error("Tabs components must be used within a Tabs component");
  }
  return context;
}

interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

interface TabsListProps {
  children: React.ReactNode;
  className?: string;
}

interface TabsTriggerProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

function Tabs({ value, onValueChange, children, className }: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

/**
 * Resolve the index of the tab to focus next for a roving-tabindex tablist.
 * Returns null for keys that are not tablist navigation keys.
 */
function nextTabIndex(
  key: string,
  current: number,
  total: number,
): number | null {
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return total - 1;
  }
  const base = current === -1 ? 0 : current;
  if (key === "ArrowRight") {
    return (base + 1) % total;
  }
  if (key === "ArrowLeft") {
    return (base - 1 + total) % total;
  }
  return null;
}

function TabsList({ children, className }: TabsListProps) {
  const { onValueChange } = useTabsContext();
  const listRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const tabs = Array.from(
      list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
    );
    if (tabs.length === 0) {
      return;
    }
    const current = tabs.indexOf(
      list.ownerDocument.activeElement as HTMLButtonElement,
    );
    const next = nextTabIndex(event.key, current, tabs.length);
    if (next === null) {
      return;
    }
    const target = tabs[next];
    if (!target) {
      return;
    }
    event.preventDefault();
    target.focus();
    const value = target.dataset.value;
    if (value !== undefined) {
      onValueChange(value);
    }
  };

  return (
    <div
      ref={listRef}
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
        className,
      )}
      role="tablist"
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

function TabsTrigger({
  value,
  children,
  className,
  disabled,
}: TabsTriggerProps) {
  const { value: currentValue, onValueChange } = useTabsContext();
  const isActive = currentValue === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      data-value={value}
      disabled={disabled}
      onClick={() => {
        return onValueChange(value);
      }}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        isActive
          ? "bg-background text-foreground shadow"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export { Tabs, TabsList, TabsTrigger };
