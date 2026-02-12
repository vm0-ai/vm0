import { useLastResolved, useSet } from "ccstate-react";
import {
  IconPlus,
  IconDotsVertical,
  IconChevronDown,
} from "@tabler/icons-react";
import forgotPasswordIcon from "./icons/forgot-password.svg";
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
  openAddSecretDialog$,
  openEditSecretDialog$,
  openDeleteSecretDialog$,
} from "../../signals/settings-page/secrets.ts";
import {
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

// ---------------------------------------------------------------------------
// Missing item row
// ---------------------------------------------------------------------------

function MissingItemRow({
  item,
  isFirst,
}: {
  item: MergedItem;
  isFirst: boolean;
}) {
  const openAddSecret = useSet(openAddSecretDialog$);
  const openAddVariable = useSet(openAddVariableDialog$);

  const badgeLabel =
    item.kind === "secret" ? "Missing secrets" : "Missing variables";

  return (
    <div
      className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl ${isFirst ? "rounded-t-xl" : ""}`}
    >
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {item.name}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 rounded-md border border-border bg-background px-1.5 py-0.5">
        <img alt="" src={forgotPasswordIcon} className="size-3" />
        <span className="text-xs font-medium text-muted-foreground">
          {badgeLabel}
        </span>
      </div>
      <button
        onClick={() =>
          item.kind === "secret"
            ? openAddSecret(item.name)
            : openAddVariable(item.name)
        }
        className="shrink-0 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
      >
        Fill
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configured secret row
// ---------------------------------------------------------------------------

function SecretRow({
  secret,
  agentRequired,
  isFirst,
}: {
  secret: SecretResponse;
  agentRequired: boolean;
  isFirst: boolean;
}) {
  const openEdit = useSet(openEditSecretDialog$);
  const openDelete = useSet(openDeleteSecretDialog$);

  return (
    <div
      className={`flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 last:border-b last:rounded-b-xl ${isFirst ? "rounded-t-xl" : ""}`}
    >
      <div className="flex flex-1 flex-col gap-1 min-w-0">
        <div className="text-sm font-medium text-foreground font-mono">
          {secret.name}
        </div>
        {secret.description && (
          <div className="text-sm text-muted-foreground">
            {secret.description}
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        {formatDate(secret.updatedAt)}
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
          {!agentRequired && (
            <button
              onClick={() => openDelete(secret.name)}
              className="w-full rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Delete
            </button>
          )}
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
  agentRequired,
  isFirst,
}: {
  variable: VariableResponse;
  agentRequired: boolean;
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
          {!agentRequired && (
            <button
              onClick={() => openDelete(variable.name)}
              className="w-full rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Delete
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item row dispatcher
// ---------------------------------------------------------------------------

function ItemRow({ item, isFirst }: { item: MergedItem; isFirst: boolean }) {
  if (item.data === null) {
    return <MissingItemRow item={item} isFirst={isFirst} />;
  }

  if (item.kind === "secret") {
    return (
      <SecretRow
        secret={item.data}
        agentRequired={item.agentRequired}
        isFirst={isFirst}
      />
    );
  }

  return (
    <VariableRow
      variable={item.data}
      agentRequired={item.agentRequired}
      isFirst={isFirst}
    />
  );
}

// ---------------------------------------------------------------------------
// Add dropdown
// ---------------------------------------------------------------------------

function AddDropdown() {
  const openAddSecret = useSet(openAddSecretDialog$);
  const openAddVariable = useSet(openAddVariableDialog$);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center self-start shrink-0 rounded-md border border-border bg-background overflow-hidden hover:bg-muted transition-colors">
          <span className="border-r border-border px-4 py-2 text-sm font-medium text-foreground">
            Add more secrets
          </span>
          <span className="pl-2 pr-3 py-2">
            <IconChevronDown
              size={16}
              stroke={1.5}
              className="text-foreground"
            />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex flex-col gap-1 w-44 p-2">
        <button
          onClick={() => openAddSecret()}
          className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          Add secret
        </button>
        <button
          onClick={() => openAddVariable()}
          className="w-full rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          Add variable
        </button>
      </PopoverContent>
    </Popover>
  );
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
            />
          ))}

      {items && (
        <div
          className={`flex flex-col gap-4 border border-border bg-card p-4 rounded-b-xl sm:flex-row sm:items-center ${items.length === 0 ? "rounded-t-xl" : ""}`}
        >
          <div className="flex flex-1 items-center gap-4 min-w-0">
            <div className="flex shrink-0 items-center justify-center size-[28px]">
              <IconPlus size={24} stroke={1.5} className="text-foreground" />
            </div>
            <div className="flex flex-1 flex-col gap-1 min-w-0">
              <div className="text-sm font-medium text-foreground">
                New secrets and variables
              </div>
              <div className="text-sm text-muted-foreground">
                Custom API keys and variables
              </div>
            </div>
          </div>
          <AddDropdown />
        </div>
      )}
    </div>
  );
}
