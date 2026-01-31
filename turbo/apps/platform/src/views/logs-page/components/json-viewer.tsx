import { useGet } from "ccstate-react";
import { JsonView, darkStyles, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { CopyButton } from "@vm0/ui";
import { theme$ } from "../../../signals/theme.ts";

interface JsonViewerProps {
  data: unknown;
  maxInitialDepth?: number;
  className?: string;
  showCopyButton?: boolean;
}

function getLightStyles() {
  return {
    ...defaultStyles,
    container: "font-mono text-xs leading-relaxed",
    label: "text-purple-600 font-medium",
    stringValue: "text-green-600",
    numberValue: "text-blue-600",
    booleanValue: "text-amber-600",
    nullValue: "text-gray-400 italic",
    undefinedValue: "text-gray-400 italic",
    punctuation: "text-gray-500",
    expandIcon:
      "text-primary hover:text-primary/80 cursor-pointer select-none before:content-['▶'] before:mr-1 before:text-[0.6em]",
    collapseIcon:
      "text-primary hover:text-primary/80 cursor-pointer select-none before:content-['▼'] before:mr-1 before:text-[0.6em]",
    collapsedContent:
      "text-primary/70 hover:text-primary cursor-pointer px-1 rounded hover:bg-primary/10",
    basicChildStyle: "pl-4",
    childFieldsContainer: "",
    clickableLabel:
      "cursor-pointer hover:underline hover:bg-primary/10 rounded px-0.5",
    otherValue: "text-gray-600",
  };
}

function getDarkStyles() {
  return {
    ...darkStyles,
    container: "font-mono text-xs leading-relaxed",
    label: "text-purple-400 font-medium",
    stringValue: "text-green-400",
    numberValue: "text-blue-400",
    booleanValue: "text-amber-400",
    nullValue: "text-gray-500 italic",
    undefinedValue: "text-gray-500 italic",
    punctuation: "text-gray-400",
    expandIcon:
      "text-primary hover:text-primary/80 cursor-pointer select-none before:content-['▶'] before:mr-1 before:text-[0.6em]",
    collapseIcon:
      "text-primary hover:text-primary/80 cursor-pointer select-none before:content-['▼'] before:mr-1 before:text-[0.6em]",
    collapsedContent:
      "text-primary/70 hover:text-primary cursor-pointer px-1 rounded hover:bg-primary/10",
    basicChildStyle: "pl-4",
    childFieldsContainer: "",
    clickableLabel:
      "cursor-pointer hover:underline hover:bg-primary/10 rounded px-0.5",
    otherValue: "text-gray-300",
  };
}

function createExpandFunction(maxInitialDepth: number) {
  return (level: number): boolean => {
    return level < maxInitialDepth;
  };
}

/**
 * Interactive JSON viewer component with dark/light theme support.
 * Uses react-json-view-lite for tree navigation with expandable nodes.
 */
export function JsonViewer({
  data,
  maxInitialDepth = 2,
  className = "",
  showCopyButton = true,
}: JsonViewerProps) {
  const theme = useGet(theme$);
  const isDark = theme === "dark";

  const styles = isDark ? getDarkStyles() : getLightStyles();
  const shouldExpandNode = createExpandFunction(maxInitialDepth);

  // Ensure data is an object or array for JsonView
  const jsonData =
    typeof data === "object" && data !== null ? data : { value: data };

  const jsonString = JSON.stringify(data, null, 2);

  return (
    <div className={`relative ${className}`}>
      {showCopyButton && (
        <div className="absolute top-0 right-0 z-10">
          <CopyButton
            text={jsonString}
            className="h-6 w-6 p-1 bg-background/80 hover:bg-background rounded"
          />
        </div>
      )}
      <div className="overflow-auto">
        <JsonView
          data={jsonData}
          style={styles}
          shouldExpandNode={shouldExpandNode}
          clickToExpandNode
        />
      </div>
    </div>
  );
}
