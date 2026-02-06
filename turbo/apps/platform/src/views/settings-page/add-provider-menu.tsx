import { useLastResolved, useSet } from "ccstate-react";
import { IconPlus, IconChevronDown } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import type { ModelProviderType } from "@vm0/core";
import { getUILabel } from "./provider-ui-config.ts";
import {
  availableProviderTypes$,
  openAddDialog$,
} from "../../signals/settings-page/model-providers.ts";
import { ProviderIcon } from "./provider-icons.tsx";

export function AddProviderMenu({ isFirst }: { isFirst: boolean }) {
  const availableTypes = useLastResolved(availableProviderTypes$);
  const openAdd = useSet(openAddDialog$);

  if (!availableTypes || availableTypes.length === 0) {
    return null;
  }

  return (
    <div
      className={`flex flex-col gap-4 border border-border bg-card p-4 rounded-b-xl sm:flex-row sm:items-center ${isFirst ? "rounded-t-xl" : ""}`}
    >
      <div className="flex flex-1 items-center gap-4 min-w-0">
        <div className="flex shrink-0 items-center justify-center size-[28px]">
          <IconPlus size={24} stroke={1.5} className="text-foreground" />
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            New model provider
          </div>
          <div className="text-sm text-muted-foreground">
            Add a new provider and connect it to your agents
          </div>
        </div>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button className="flex items-center self-start shrink-0 rounded-lg border border-border bg-background overflow-hidden hover:bg-muted transition-colors">
            <span className="px-4 py-2 text-sm font-medium text-foreground border-r border-border">
              Add more model provider
            </span>
            <span className="px-2 py-2 flex items-center justify-center">
              <IconChevronDown size={20} stroke={1.5} />
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[var(--radix-popover-trigger-width)] p-2"
        >
          {availableTypes.map((type: ModelProviderType) => (
            <button
              key={type}
              onClick={() => openAdd(type)}
              className="w-full flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 px-3 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <ProviderIcon type={type} size={16} />
              <span>{getUILabel(type)}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
