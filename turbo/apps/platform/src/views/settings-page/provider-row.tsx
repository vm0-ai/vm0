import { useSet } from "ccstate-react";
import { IconDotsVertical } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import type { ModelProviderResponse } from "@vm0/core";
import { getUILabel, getUIDescription } from "./provider-ui-config.ts";
import {
  openEditDialog$,
  openDeleteDialog$,
} from "../../signals/settings-page/model-providers.ts";
import { ProviderIcon } from "./provider-icons.tsx";

export function ProviderRow({
  provider,
  isFirst,
}: {
  provider: ModelProviderResponse;
  isFirst: boolean;
}) {
  const openEdit = useSet(openEditDialog$);
  const openDelete = useSet(openDeleteDialog$);
  const label = getUILabel(provider.type);
  const description = getUIDescription(provider.type);

  return (
    <div
      className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl ${isFirst ? "rounded-t-xl" : ""}`}
    >
      <div className="shrink-0">
        <ProviderIcon type={provider.type} size={28} />
      </div>
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-sm text-muted-foreground">{description}</div>
        )}
      </div>
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
