import { useLastResolved, useSet } from "ccstate-react";
import { IconPlus } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { getSelectableProviderTypes, type ModelProviderType } from "@vm0/core";
import {
  orgConfiguredProviders$,
  orgOpenAddDialog$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { getUILabel, getUIDescription } from "./provider-ui-config.ts";
import { ProviderIcon } from "./provider-icons.tsx";

function getProviderTypes(): ModelProviderType[] {
  return getSelectableProviderTypes();
}

function ProviderCardInDialog({
  type,
  onAdd,
}: {
  type: ModelProviderType;
  onAdd: () => void;
}) {
  const label = getUILabel(type);
  const description = getUIDescription(type);

  return (
    <button
      type="button"
      onClick={onAdd}
      className="rounded-lg bg-card overflow-hidden transition-colors hover:bg-muted/30 cursor-pointer text-left w-full"
      style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      data-testid={`org-provider-card-${type}`}
    >
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-1">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ProviderIcon type={type} size={20} />
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
          {label}
        </span>
        <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground">
          <IconPlus size={14} stroke={1.5} />
        </span>
      </div>
      {description && (
        <div className="px-4 pb-4 pt-1">
          <div className="text-xs text-muted-foreground line-clamp-2">
            {description}
          </div>
        </div>
      )}
    </button>
  );
}

export function OrgAddProviderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const configuredProviders = useLastResolved(orgConfiguredProviders$);
  const openAdd = useSet(orgOpenAddDialog$);
  const configuredSet = new Set(
    configuredProviders?.map((p) => {
      return p.type;
    }) ?? [],
  );

  const handleAdd = (type: ModelProviderType) => {
    openAdd(type);
  };

  const availableTypes = getProviderTypes().filter((type) => {
    return !configuredSet.has(type);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden pr-0 pb-0">
        <DialogHeader>
          <DialogTitle>Add workspace model provider</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="pt-4 pb-6 pr-6">
            {availableTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                All providers have been configured.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {availableTypes.map((type) => {
                  return (
                    <ProviderCardInDialog
                      key={type}
                      type={type}
                      onAdd={() => {
                        return handleAdd(type);
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
