import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
  IconCheck,
} from "@tabler/icons-react";
import {
  getEventStyle,
  KNOWN_EVENT_TYPES,
} from "../../constants/event-styles.ts";

export function EventTypeFilterDropdown({
  counts,
  hiddenTypes,
  setHiddenTypes,
}: {
  counts: Map<string, number>;
  hiddenTypes: Set<string>;
  setHiddenTypes: (types: Set<string>) => void;
}) {
  const toggleType = (type: string) => {
    const newHidden = new Set(hiddenTypes);
    if (newHidden.has(type)) {
      newHidden.delete(type);
    } else {
      newHidden.add(type);
    }
    setHiddenTypes(newHidden);
  };

  const existingTypes = KNOWN_EVENT_TYPES.filter(
    (type) => (counts.get(type) ?? 0) > 0,
  );

  const unknownTypes = Array.from(counts.keys()).filter(
    (type) =>
      !KNOWN_EVENT_TYPES.includes(type as (typeof KNOWN_EVENT_TYPES)[number]),
  );

  const allTypes = [...existingTypes, ...unknownTypes];
  const visibleCount = allTypes.filter((type) => !hiddenTypes.has(type)).length;
  const isAllSelected = visibleCount === allTypes.length;

  const selectAll = () => {
    setHiddenTypes(new Set());
  };

  if (allTypes.length === 0) {
    return null;
  }

  return (
    <details className="relative group">
      <summary className="flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-md bg-card hover:bg-muted transition-colors cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <IconAdjustmentsHorizontal className="h-4 w-4 text-muted-foreground" />
        <span className="text-foreground">
          {isAllSelected ? "All types" : `${visibleCount} types`}
        </span>
        <IconChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>

      <div className="absolute top-full left-0 mt-1 w-48 bg-card border border-border rounded-md shadow-lg z-50">
        <div className="p-1">
          <button
            onClick={selectAll}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-muted transition-colors"
          >
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center ${isAllSelected ? "bg-sidebar-primary border-sidebar-primary" : "border-border"}`}
            >
              {isAllSelected && <IconCheck className="h-3 w-3 text-white" />}
            </div>
            <span>All types</span>
          </button>
          <div className="h-px bg-border my-1" />
          {allTypes.map((type) => {
            const style = getEventStyle(type);
            const count = counts.get(type) ?? 0;
            const isVisible = !hiddenTypes.has(type);

            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded hover:bg-muted transition-colors"
              >
                <div
                  className={`w-4 h-4 rounded border flex items-center justify-center ${isVisible ? "bg-sidebar-primary border-sidebar-primary" : "border-border"}`}
                >
                  {isVisible && <IconCheck className="h-3 w-3 text-white" />}
                </div>
                <span>{style.label}</span>
                <span className="text-muted-foreground ml-auto">({count})</span>
              </button>
            );
          })}
        </div>
      </div>
    </details>
  );
}
