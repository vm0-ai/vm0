import { useLastResolved, useSet } from "ccstate-react";
import { IconPlus, IconDotsVertical } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { Button } from "@vm0/ui/components/ui/button";
import type { SecretResponse } from "@vm0/core";
import {
  secrets$,
  missingSecrets$,
  openAddSecretDialog$,
  openEditSecretDialog$,
  openDeleteSecretDialog$,
} from "../../signals/settings-page/secrets.ts";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SecretRow({
  secret,
  isFirst,
}: {
  secret: SecretResponse;
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

function MissingSecretsBanner({ names }: { names: string[] }) {
  const openAdd = useSet(openAddSecretDialog$);

  return (
    <div className="rounded-xl border border-yellow-500/50 bg-yellow-500/5 p-4">
      <h4 className="text-sm font-medium text-foreground mb-2">
        Required secrets not configured
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

export function SecretList() {
  const secretsList = useLastResolved(secrets$);
  const missing = useLastResolved(missingSecrets$);
  const openAdd = useSet(openAddSecretDialog$);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">Secrets</h3>
        <p className="text-sm text-muted-foreground">
          Encrypted credentials used by your agents. Values are never displayed
          after saving.
        </p>
      </div>

      {missing && missing.length > 0 && (
        <MissingSecretsBanner names={missing} />
      )}

      <div className="flex flex-col">
        {secretsList &&
          secretsList.map((secret, index) => (
            <SecretRow key={secret.id} secret={secret} isFirst={index === 0} />
          ))}

        <div
          className={`flex flex-col gap-4 border border-border bg-card p-4 rounded-b-xl sm:flex-row sm:items-center ${!secretsList || secretsList.length === 0 ? "rounded-t-xl" : ""}`}
        >
          <div className="flex flex-1 items-center gap-4 min-w-0">
            <div className="flex shrink-0 items-center justify-center size-[28px]">
              <IconPlus size={24} stroke={1.5} className="text-foreground" />
            </div>
            <div className="flex flex-1 flex-col gap-1 min-w-0">
              <div className="text-sm font-medium text-foreground">
                {!secretsList || secretsList.length === 0
                  ? "No secrets configured yet"
                  : "New secret"}
              </div>
              <div className="text-sm text-muted-foreground">
                {!secretsList || secretsList.length === 0
                  ? "Add your first encrypted credential"
                  : "Add a new encrypted credential for your agents"}
              </div>
            </div>
          </div>
          <button
            onClick={() => openAdd()}
            className="flex items-center self-start shrink-0 rounded-lg border border-border bg-background overflow-hidden hover:bg-muted transition-colors"
          >
            <span className="px-4 py-2 text-sm font-medium text-foreground">
              Add secret
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
