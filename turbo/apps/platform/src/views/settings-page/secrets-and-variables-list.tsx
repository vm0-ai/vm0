import { useLastResolved, useSet } from "ccstate-react";
import { IconDotsVertical } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import type { SecretResponse, VariableResponse } from "@vm0/core";
import {
  mergedItems$,
  type MergedItem,
} from "../../signals/settings-page/secrets-and-variables.ts";
import {
  openEditSecretDialog$,
  openDeleteSecretDialog$,
} from "../../signals/settings-page/secrets.ts";
import {
  openEditVariableDialog$,
  openDeleteVariableDialog$,
} from "../../signals/settings-page/variables.ts";

function truncateValue(value: string, maxLength = 60): string {
  return value.length > maxLength
    ? value.substring(0, maxLength) + "..."
    : value;
}

// ---------------------------------------------------------------------------
// Configured secret row
// ---------------------------------------------------------------------------

function SecretRow({
  secret,
  isFirst,
  index,
}: {
  secret: SecretResponse;
  isFirst: boolean;
  index: number;
}) {
  const openEdit = useSet(openEditSecretDialog$);
  const openDelete = useSet(openDeleteSecretDialog$);

  return (
    <div
      className={`relative z-[var(--row-z)] flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl transition-colors hover:bg-muted/50 ${isFirst ? "rounded-t-xl" : ""}`}
      style={{ "--row-z": index } as React.CSSProperties}
    >
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {secret.name}
        </div>
        <div className="text-sm text-muted-foreground font-mono">••••••••</div>
        {secret.description && (
          <div className="text-xs text-muted-foreground">
            {secret.description}
          </div>
        )}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button className="icon-button shrink-0" aria-label="Secret options">
            <IconDotsVertical
              size={16}
              stroke={1.5}
              className="text-muted-foreground"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex flex-col gap-1 w-36 p-2">
          <button
            onClick={() => openEdit(secret)}
            className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Edit
          </button>
          <button
            onClick={() => openDelete(secret.name)}
            className="w-full rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            Delete
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configured variable row
// ---------------------------------------------------------------------------

function VariableRow({
  variable,
  isFirst,
  index,
}: {
  variable: VariableResponse;
  isFirst: boolean;
  index: number;
}) {
  const openEdit = useSet(openEditVariableDialog$);
  const openDelete = useSet(openDeleteVariableDialog$);

  return (
    <div
      className={`relative z-[var(--row-z)] flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl transition-colors hover:bg-muted/50 ${isFirst ? "rounded-t-xl" : ""}`}
      style={{ "--row-z": index } as React.CSSProperties}
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

// ---------------------------------------------------------------------------
// Item row dispatcher
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  isFirst,
  index,
}: {
  item: MergedItem;
  isFirst: boolean;
  index: number;
}) {
  if (item.kind === "secret") {
    return <SecretRow secret={item.data} isFirst={isFirst} index={index} />;
  }

  return <VariableRow variable={item.data} isFirst={isFirst} index={index} />;
}

// ---------------------------------------------------------------------------
// Main list
// ---------------------------------------------------------------------------

export function SecretsAndVariablesList() {
  const items = useLastResolved(mergedItems$);

  return (
    <div className="flex flex-col">
      {!items
        ? ["sv1", "sv2", "sv3"].map((id, i) => (
            <div
              key={id}
              className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 animate-pulse ${i === 0 ? "rounded-t-xl" : ""} ${i === 2 ? "rounded-b-xl border-b" : ""}`}
            >
              <div className="flex flex-1 flex-col gap-2">
                <div className="h-4 w-32 rounded bg-muted" />
                <div className="h-3 w-48 rounded bg-muted" />
              </div>
              <div className="h-3 w-16 rounded bg-muted" />
            </div>
          ))
        : items.map((item, index) => (
            <ItemRow
              key={`${item.kind}-${item.name}`}
              item={item}
              isFirst={index === 0}
              index={index}
            />
          ))}
    </div>
  );
}
