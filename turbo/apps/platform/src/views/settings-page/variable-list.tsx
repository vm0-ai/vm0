import { useLastResolved, useSet } from "ccstate-react";
import { IconPlus, IconDotsVertical } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { Button } from "@vm0/ui/components/ui/button";
import type { VariableResponse } from "@vm0/core";
import {
  variables$,
  missingVariables$,
  openAddVariableDialog$,
  openEditVariableDialog$,
  openDeleteVariableDialog$,
} from "../../signals/settings-page/variables.ts";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function truncateValue(value: string, maxLength = 60): string {
  return value.length > maxLength
    ? value.substring(0, maxLength) + "..."
    : value;
}

function VariableRow({
  variable,
  isFirst,
}: {
  variable: VariableResponse;
  isFirst: boolean;
}) {
  const openEdit = useSet(openEditVariableDialog$);
  const openDelete = useSet(openDeleteVariableDialog$);

  return (
    <div
      className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl ${isFirst ? "rounded-t-xl" : ""}`}
    >
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {variable.name}
        </div>
        <div className="text-sm text-muted-foreground font-mono truncate">
          {truncateValue(variable.value)}
        </div>
        {variable.description && (
          <div className="text-xs text-muted-foreground">
            {variable.description}
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        {formatDate(variable.updatedAt)}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="icon-button shrink-0"
            aria-label="Variable options"
          >
            <IconDotsVertical
              size={16}
              stroke={1.5}
              className="text-muted-foreground"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex flex-col gap-1 w-36 p-2">
          <button
            onClick={() => openEdit(variable)}
            className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Edit
          </button>
          <button
            onClick={() => openDelete(variable.name)}
            className="w-full rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Delete
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function MissingVariablesBanner({ names }: { names: string[] }) {
  const openAdd = useSet(openAddVariableDialog$);

  return (
    <div className="rounded-xl border border-yellow-500/50 bg-yellow-500/5 p-4">
      <h4 className="text-sm font-medium text-foreground mb-2">
        Required variables not configured
      </h4>
      <div className="flex flex-col gap-2">
        {names.map((name) => (
          <div key={name} className="flex items-center gap-3">
            <span className="text-sm font-mono text-foreground">{name}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
              Not configured
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openAdd(name)}
              className="ml-auto"
            >
              Add
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function VariableList() {
  const variablesList = useLastResolved(variables$);
  const missing = useLastResolved(missingVariables$);
  const openAdd = useSet(openAddVariableDialog$);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">Variables</h3>
        <p className="text-sm text-muted-foreground">
          Plaintext configuration values used by your agents. Values are visible
          after saving.
        </p>
      </div>

      {missing && missing.length > 0 && (
        <MissingVariablesBanner names={missing} />
      )}

      <div className="flex flex-col">
        {variablesList &&
          variablesList.map((variable, index) => (
            <VariableRow
              key={variable.id}
              variable={variable}
              isFirst={index === 0}
            />
          ))}

        <div
          className={`flex flex-col gap-4 border border-border bg-card p-4 rounded-b-xl sm:flex-row sm:items-center ${!variablesList || variablesList.length === 0 ? "rounded-t-xl" : ""}`}
        >
          <div className="flex flex-1 items-center gap-4 min-w-0">
            <div className="flex shrink-0 items-center justify-center size-[28px]">
              <IconPlus size={24} stroke={1.5} className="text-foreground" />
            </div>
            <div className="flex flex-1 flex-col gap-1 min-w-0">
              <div className="text-sm font-medium text-foreground">
                {!variablesList || variablesList.length === 0
                  ? "No variables configured yet"
                  : "New variable"}
              </div>
              <div className="text-sm text-muted-foreground">
                {!variablesList || variablesList.length === 0
                  ? "Add your first configuration value"
                  : "Add a new configuration value for your agents"}
              </div>
            </div>
          </div>
          <button
            onClick={() => openAdd()}
            className="flex items-center self-start shrink-0 rounded-lg border border-border bg-background overflow-hidden hover:bg-muted transition-colors"
          >
            <span className="px-4 py-2 text-sm font-medium text-foreground">
              Add variable
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
