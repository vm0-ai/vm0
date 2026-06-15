import { useGet, useSet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconLoader2, IconPlus, IconTrash } from "@tabler/icons-react";
import type { ApiKeyItem } from "@vm0/api-contracts/contracts/api-keys";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui/components/ui/table";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import { detach, Reason } from "../../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../../signals/page-signal.ts";
import {
  apiKeys$,
  apiKeysCreateDialogOpen$,
  apiKeysFormExpiry$,
  apiKeysFormName$,
  apiKeysPendingRevokeId$,
  apiKeysRevealedToken$,
  apiKeysRevokeTarget$,
  closeCreateApiKeyDialog$,
  closeRevealModal$,
  closeRevokeConfirm$,
  confirmRevokeApiKey$,
  openCreateApiKeyDialog$,
  openRevokeConfirm$,
  setApiKeyFormExpiry$,
  setApiKeyFormName$,
  submitCreateApiKey$,
} from "../../../../../signals/api-keys-page/api-keys-signals.ts";

const EXPIRY_OPTIONS = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
  { value: 3650, label: "Never (10 years)" },
] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function formatLastUsed(iso: string | null): string {
  if (!iso) {
    return "Never";
  }
  return new Date(iso).toLocaleDateString();
}

function ApiKeysTable({ keys }: { keys: ApiKeyItem[] }) {
  const pendingRevokeId = useGet(apiKeysPendingRevokeId$);
  const openRevoke = useSet(openRevokeConfirm$);

  if (keys.length === 0) {
    return (
      <div className="rounded-xl zero-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
        No API keys yet. Create one to access <code>/api/v1</code>.
      </div>
    );
  }
  return (
    <div className="rounded-xl zero-border bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Token</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((k) => {
            const revoking = pendingRevokeId === k.id;
            return (
              <TableRow key={k.id}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell>
                  <code className="text-xs">{k.tokenPrefix}</code>
                </TableCell>
                <TableCell>{formatDate(k.createdAt)}</TableCell>
                <TableCell>{formatLastUsed(k.lastUsedAt)}</TableCell>
                <TableCell>{formatDate(k.expiresAt)}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoking}
                    onClick={() => {
                      openRevoke(k);
                    }}
                    aria-label={`Revoke ${k.name}`}
                  >
                    {revoking ? (
                      <IconLoader2
                        size={16}
                        className="animate-spin text-muted-foreground"
                      />
                    ) : (
                      <IconTrash size={16} className="text-muted-foreground" />
                    )}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function CreateApiKeyDialog() {
  const open = useGet(apiKeysCreateDialogOpen$);
  const name = useGet(apiKeysFormName$);
  const setName = useSet(setApiKeyFormName$);
  const expiresInDays = useGet(apiKeysFormExpiry$);
  const setExpiresInDays = useSet(setApiKeyFormExpiry$);
  const closeDialog = useSet(closeCreateApiKeyDialog$);
  const pageSignal = useGet(pageSignal$);
  const [submitLoadable, submit] = useLoadableSet(submitCreateApiKey$);
  const submitting = submitLoadable.state === "loading";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeDialog();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            This key grants access to <code>/api/v1</code> for your current
            organization.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="api-key-name-new" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="api-key-name-new"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="e.g. CI bot"
              maxLength={100}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="api-key-expiry-new" className="text-sm font-medium">
              Expiration
            </label>
            <Select
              value={String(expiresInDays)}
              onValueChange={(v) => {
                setExpiresInDays(Number(v));
              }}
            >
              <SelectTrigger id="api-key-expiry-new">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((opt) => {
                  return (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeDialog} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              detach(submit(pageSignal), Reason.DomCallback);
            }}
            disabled={submitting || name.trim().length === 0}
          >
            {submitting ? (
              <IconLoader2 size={16} className="animate-spin" />
            ) : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeConfirmDialog() {
  const target = useGet(apiKeysRevokeTarget$);
  const close = useSet(closeRevokeConfirm$);
  const pageSignal = useGet(pageSignal$);
  const [loadable, confirm] = useLoadableSet(confirmRevokeApiKey$);
  const submitting = loadable.state === "loading";

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke {target?.name ?? "this key"}?</DialogTitle>
          <DialogDescription>
            The token will stop working immediately for <code>/api/v1</code>.
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              detach(confirm(pageSignal), Reason.DomCallback);
            }}
            disabled={submitting}
          >
            {submitting ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevealTokenModal() {
  const revealed = useGet(apiKeysRevealedToken$);
  const close = useSet(closeRevealModal$);

  return (
    <Dialog
      open={revealed !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
          <DialogDescription>
            Copy this token now — you won&apos;t be able to see it again.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <div className="text-sm text-muted-foreground">
            {revealed?.name ?? ""}
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
            <code className="flex-1 break-all text-xs">
              {revealed?.token ?? ""}
            </code>
            <CopyButton text={revealed?.token ?? ""} />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={close}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysSection() {
  const apiKeysLoadable = useLoadable(apiKeys$);
  const openCreate = useSet(openCreateApiKeyDialog$);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        <Button onClick={openCreate}>
          <IconPlus size={16} />
          Create API key
        </Button>
      </div>

      {apiKeysLoadable.state === "loading" && (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <IconLoader2 size={20} className="animate-spin" />
        </div>
      )}
      {apiKeysLoadable.state === "hasError" && (
        <div className="rounded-xl zero-border bg-card px-6 py-10 text-center text-sm text-destructive">
          Failed to load API keys.
        </div>
      )}
      {apiKeysLoadable.state === "hasData" && (
        <ApiKeysTable keys={apiKeysLoadable.data.apiKeys} />
      )}

      <CreateApiKeyDialog />
      <RevokeConfirmDialog />
      <RevealTokenModal />
    </div>
  );
}
