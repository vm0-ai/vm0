import { useSet } from "ccstate-react";
import { IconDotsVertical } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { MODEL_PROVIDER_TYPES, type ModelProviderResponse } from "@vm0/core";
import {
  openEditDialog$,
  openDeleteDialog$,
} from "../../signals/settings-page/model-providers.ts";
import { ProviderIcon } from "./provider-icons.tsx";

export function ProviderRow({ provider }: { provider: ModelProviderResponse }) {
  const openEdit = useSet(openEditDialog$);
  const openDelete = useSet(openDeleteDialog$);
  const config = MODEL_PROVIDER_TYPES[provider.type];

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0">
      <div className="shrink-0">
        <ProviderIcon type={provider.type} size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">
          {config.label}
        </div>
        {provider.selectedModel && (
          <div className="text-xs text-muted-foreground truncate">
            {provider.selectedModel}
          </div>
        )}
      </div>
      {provider.isDefault && (
        <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full shrink-0">
          Default
        </span>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="p-1 rounded-md hover:bg-muted transition-colors shrink-0"
            aria-label="Provider options"
          >
            <IconDotsVertical
              size={16}
              stroke={1.5}
              className="text-muted-foreground"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-36 p-0">
          <button
            onClick={() => openEdit(provider)}
            className="w-full px-3 py-2 text-sm text-left hover:bg-muted transition-colors"
          >
            Edit
          </button>
          <button
            onClick={() => openDelete(provider.type)}
            className="w-full px-3 py-2 text-sm text-left text-destructive hover:bg-muted transition-colors"
          >
            Delete
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
