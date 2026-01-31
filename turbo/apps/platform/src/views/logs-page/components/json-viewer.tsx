import { JsonView, darkStyles, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { CopyButton } from "@vm0/ui";

interface JsonViewerProps {
  data: unknown;
  defaultExpanded?: boolean;
  maxInitialDepth?: number;
  className?: string;
  showCopyButton?: boolean;
}

function getStyles(isDark: boolean) {
  const baseStyles = isDark ? darkStyles : defaultStyles;
  return {
    ...baseStyles,
    container: "font-mono text-sm",
    basicChildStyle: "pl-4",
    label: isDark ? "text-purple-400 mr-1" : "text-purple-600 mr-1",
    nullValue: "text-gray-500",
    undefinedValue: "text-gray-500",
    stringValue: isDark ? "text-green-400" : "text-green-600",
    booleanValue: isDark ? "text-amber-400" : "text-amber-600",
    numberValue: isDark ? "text-blue-400" : "text-blue-600",
    otherValue: "text-foreground",
    punctuation: "text-muted-foreground",
    collapseIcon:
      "inline-block w-4 h-4 mr-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors",
    expandIcon:
      "inline-block w-4 h-4 mr-1 cursor-pointer text-muted-foreground hover:text-foreground transition-colors",
    collapsedContent:
      "text-muted-foreground cursor-pointer hover:text-foreground",
  };
}

function getExpandFn(
  maxDepth: number,
  expandAll: boolean,
): (level: number, value: unknown, field: string | undefined) => boolean {
  if (expandAll) {
    return () => true;
  }
  return (level: number) => level < maxDepth;
}

export function JsonViewer({
  data,
  defaultExpanded = false,
  maxInitialDepth = 2,
  className,
  showCopyButton = true,
}: JsonViewerProps) {
  // Detect dark mode using CSS media query
  const isDarkMode =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const styles = getStyles(isDarkMode);
  const jsonString = JSON.stringify(data, null, 2);
  const expandFn = getExpandFn(maxInitialDepth, defaultExpanded);

  return (
    <div className={`relative ${className ?? ""}`}>
      {showCopyButton && (
        <div className="absolute top-0 right-0 z-10">
          <CopyButton
            text={jsonString}
            className="h-6 w-6 p-1 opacity-50 hover:opacity-100"
          />
        </div>
      )}
      <div className="overflow-x-auto rounded bg-muted/30 p-3 pr-8">
        <JsonView
          data={data as object}
          shouldExpandNode={expandFn}
          style={styles}
        />
      </div>
    </div>
  );
}
