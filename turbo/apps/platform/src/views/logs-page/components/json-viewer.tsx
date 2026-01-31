import { useGet } from "ccstate-react";
import {
  JsonView,
  darkStyles,
  defaultStyles,
  collapseAllNested,
} from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { CopyButton } from "@vm0/ui";
import { theme$ } from "../../../signals/theme.ts";
import { throwIfAbort } from "../../../signals/utils.ts";

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
    expandIcon: "text-gray-400 hover:text-gray-600 cursor-pointer select-none",
    collapseIcon:
      "text-gray-400 hover:text-gray-600 cursor-pointer select-none",
    collapsedContent: "text-gray-400",
    basicChildStyle: "pl-4",
    childFieldsContainer: "",
    clickableLabel: "cursor-pointer hover:underline",
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
    expandIcon: "text-gray-500 hover:text-gray-300 cursor-pointer select-none",
    collapseIcon:
      "text-gray-500 hover:text-gray-300 cursor-pointer select-none",
    collapsedContent: "text-gray-500",
    basicChildStyle: "pl-4",
    childFieldsContainer: "",
    clickableLabel: "cursor-pointer hover:underline",
    otherValue: "text-gray-300",
  };
}

function createExpandFunction(maxInitialDepth: number) {
  return (level: number): boolean => {
    if (maxInitialDepth === 0) {
      return false;
    }
    return collapseAllNested(level) && level < maxInitialDepth;
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

/**
 * Parse JSON string safely, returning the parsed object or null.
 */
export function parseJsonSafely(value: string): object | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as object;
    }
    return null;
  } catch (error) {
    throwIfAbort(error);
    return null;
  }
}
