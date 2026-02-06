import { useLastResolved, useSet } from "ccstate-react";
import { IconPlus } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { MODEL_PROVIDER_TYPES, type ModelProviderType } from "@vm0/core";
import {
  availableProviderTypes$,
  openAddDialog$,
} from "../../signals/settings-page/model-providers.ts";
import { ProviderIcon } from "./provider-icons.tsx";

export function AddProviderMenu() {
  const availableTypes = useLastResolved(availableProviderTypes$);
  const openAdd = useSet(openAddDialog$);

  if (!availableTypes || availableTypes.length === 0) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors w-full">
          <IconPlus size={16} stroke={1.5} />
          <span>New model provider</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        {availableTypes.map((type: ModelProviderType) => (
          <button
            key={type}
            onClick={() => openAdd(type)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-muted transition-colors"
          >
            <ProviderIcon type={type} size={16} />
            <span>{MODEL_PROVIDER_TYPES[type].label}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
