import { IconChevronDown, IconClearAll } from "@tabler/icons-react";
import { Popover, PopoverContent, PopoverTrigger, Checkbox } from "@vm0/ui";
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

  const toggleAll = () => {
    if (isAllSelected) {
      setHiddenTypes(new Set(allTypes));
    } else {
      setHiddenTypes(new Set());
    }
  };

  if (allTypes.length === 0) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger className="flex items-center gap-2 px-3 py-1.5 text-sm border border-border rounded-md bg-card hover:bg-muted transition-colors cursor-pointer">
        <IconClearAll className="h-4 w-4 text-foreground" />
        <span className="text-foreground">
          {isAllSelected ? "All types" : `${visibleCount} types`}
        </span>
        <IconChevronDown className="h-4 w-4 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent align="start">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          Event types
        </div>
        <button
          onClick={toggleAll}
          className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left rounded-sm transition-colors hover:bg-accent"
        >
          <Checkbox
            checked={isAllSelected}
            onCheckedChange={() => toggleAll()}
          />
          <span>All</span>
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
              className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left rounded-sm transition-colors hover:bg-accent"
            >
              <Checkbox
                checked={isVisible}
                onCheckedChange={() => toggleType(type)}
              />
              <span>{style.label}</span>
              <span className="text-muted-foreground ml-auto">({count})</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
