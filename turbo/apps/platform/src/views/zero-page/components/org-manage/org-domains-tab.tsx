// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconPlus,
  IconTrash,
  IconCircleCheck,
  IconAlertCircle,
  IconWorldWww,
  IconDots,
  IconShieldCheck,
  IconShieldOff,
} from "@tabler/icons-react";
import {
  cn,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import type {
  OrgDomain,
  OrgEnrollmentMode,
} from "@vm0/api-contracts/contracts/org-members";
import { orgDomains$ } from "../../../../signals/external/org-domains.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  addDomainDialogOpen$,
  setAddDomainDialogOpen$,
  addDomainName$,
  setAddDomainName$,
  addDomainEnrollmentMode$,
  setAddDomainEnrollmentMode$,
  removeDomainDialogTarget$,
  setRemoveDomainDialogTarget$,
  addDomain$,
  removeDomain$,
  setDomainVerified$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENROLLMENT_MODE_LABELS = {
  manual_invitation: "Manual invitation",
  automatic_invitation: "Automatic invitation",
  automatic_suggestion: "Automatic suggestion",
} as const satisfies Record<OrgEnrollmentMode, string>;

const ENROLLMENT_MODE_DESCRIPTIONS = {
  manual_invitation: "Only invited users can join",
  automatic_invitation: "Users with matching email are auto-invited",
  automatic_suggestion: "Users with matching email are suggested to join",
} as const satisfies Record<OrgEnrollmentMode, string>;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

const ROW_GRID =
  "grid grid-cols-[1fr_10rem_6rem_6rem_2rem] gap-x-4 items-center";

export function OrgDomainsTab() {
  const domainsLoadable = useLoadable(orgDomains$);

  const domains =
    domainsLoadable.state === "hasData" ? domainsLoadable.data : [];
  const isLoading = domainsLoadable.state === "loading";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <AddDomainDialog />
      </div>

      <div
        className="overflow-hidden rounded-xl bg-card"
        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
      >
        <div
          className={cn(
            ROW_GRID,
            "sticky top-0 z-10 px-5 py-2.5 text-[13px] font-medium text-foreground bg-card",
          )}
        >
          <div>Domain</div>
          <div>Enrollment</div>
          <div>Added</div>
          <div>Status</div>
          <div />
        </div>
        <div className="h-px bg-border/40 mx-5" />

        {isLoading && (
          <>
            <DomainRowSkeleton />
            <DomainRowSkeleton />
          </>
        )}

        {!isLoading && domains.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <IconWorldWww
              size={24}
              stroke={1.2}
              className="text-muted-foreground/40"
            />
            <span className="text-sm text-muted-foreground">
              No domains configured
            </span>
          </div>
        )}

        {!isLoading &&
          domains.map((domain, i) => {
            return (
              <div key={domain.id}>
                {i > 0 && <div className="h-px bg-border/40 mx-5" />}
                <DomainRow domain={domain} />
              </div>
            );
          })}
      </div>
    </div>
  );
}

function AddDomainDialog() {
  const open = useGet(addDomainDialogOpen$);
  const setOpen = useSet(setAddDomainDialogOpen$);
  const name = useGet(addDomainName$);
  const setName = useSet(setAddDomainName$);
  const enrollmentMode = useGet(addDomainEnrollmentMode$);
  const setEnrollmentMode = useSet(setAddDomainEnrollmentMode$);
  const [loadable, doAdd] = useLoadableSet(addDomain$);
  const adding = loadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const trimmed = name.trim().toLowerCase();
  const isValid =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      trimmed,
    );

  const handleAdd = () => {
    detach(
      doAdd(trimmed, enrollmentMode, pageSignal).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to add domain";
        toast.error(message);
      }),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!adding) {
          setOpen(v);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 rounded-lg">
          <IconPlus size={14} stroke={2} />
          Add domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add domain</DialogTitle>
          <DialogDescription>
            Add a domain to enable domain-based membership management.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Domain</label>
            <Input
              placeholder="example.com"
              value={name}
              disabled={adding}
              onChange={(e) => {
                return setName(e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Enrollment mode</label>
            <Select
              value={enrollmentMode}
              onValueChange={(v) => {
                return setEnrollmentMode(v as OrgEnrollmentMode);
              }}
              disabled={adding}
            >
              <SelectTrigger>
                <span>{ENROLLMENT_MODE_LABELS[enrollmentMode]}</span>
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.entries(ENROLLMENT_MODE_LABELS) as [
                    OrgEnrollmentMode,
                    string,
                  ][]
                ).map(([mode, label]) => {
                  return (
                    <SelectItem key={mode} value={mode}>
                      <div className="flex flex-col">
                        <span>{label}</span>
                        <span className="text-xs text-muted-foreground">
                          {ENROLLMENT_MODE_DESCRIPTIONS[mode]}
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              return setOpen(false);
            }}
            disabled={adding}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!isValid || adding} onClick={handleAdd}>
            {adding ? "Adding..." : "Add domain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DomainRow({ domain }: { domain: OrgDomain }) {
  const removeTarget = useGet(removeDomainDialogTarget$);
  const setRemoveTarget = useSet(setRemoveDomainDialogTarget$);
  const removeOpen = removeTarget === domain.id;
  const [removeLoadable, doRemove] = useLoadableSet(removeDomain$);
  const [verifyLoadable, doSetVerified] = useLoadableSet(setDomainVerified$);
  const removing = removeLoadable.state === "loading";
  const settingVerified = verifyLoadable.state === "loading";
  const isVerified = domain.verification.status === "verified";
  const pageSignal = useGet(pageSignal$);

  const handleRemove = () => {
    detach(
      doRemove(domain.id, pageSignal).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to remove domain";
        toast.error(message);
      }),
      Reason.DomCallback,
    );
  };

  const handleSetVerified = (verified: boolean) => {
    detach(
      doSetVerified(domain.id, verified, pageSignal).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Failed to update domain";
        toast.error(message);
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div data-testid="domain-row" className={cn(ROW_GRID, "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
          <IconWorldWww size={16} stroke={1.5} />
        </div>
        <p className="text-sm font-medium text-foreground truncate">
          {domain.name}
        </p>
      </div>
      <div className="text-[13px] text-muted-foreground">
        {ENROLLMENT_MODE_LABELS[domain.enrollmentMode as OrgEnrollmentMode] ??
          domain.enrollmentMode.replace(/_/g, " ")}
      </div>
      <div className="text-[13px] text-muted-foreground tabular-nums">
        {formatDate(domain.createdAt)}
      </div>
      <div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
            isVerified ? "text-green-600" : "text-amber-600",
          )}
          style={{
            border: "0.7px solid hsl(var(--gray-400))",
            backgroundColor: "hsl(var(--gray-0))",
          }}
        >
          {isVerified ? (
            <IconCircleCheck size={12} stroke={1.8} />
          ) : (
            <IconAlertCircle size={12} stroke={1.8} />
          )}
          {isVerified ? "Verified" : "Unverified"}
        </span>
      </div>
      <div className="flex justify-end">
        <Dialog
          open={removeOpen}
          onOpenChange={(v) => {
            if (!removing) {
              setRemoveTarget(v ? domain.id : null);
            }
          }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted transition-colors"
                disabled={settingVerified}
              >
                <IconDots size={14} stroke={1.5} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  return handleSetVerified(!isVerified);
                }}
                disabled={settingVerified}
              >
                {isVerified ? (
                  <IconShieldOff size={14} stroke={1.5} className="mr-2" />
                ) : (
                  <IconShieldCheck size={14} stroke={1.5} className="mr-2" />
                )}
                {isVerified ? "Unverify" : "Verify"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => {
                  return setRemoveTarget(domain.id);
                }}
              >
                <IconTrash size={14} stroke={1.5} className="mr-2" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove domain?</DialogTitle>
              <DialogDescription>
                The domain {domain.name} will be removed from this workspace.
                Any domain-based membership rules will stop working.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  return setRemoveTarget(null);
                }}
                disabled={removing}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={removing}
                onClick={handleRemove}
              >
                {removing ? "Removing..." : "Remove"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function DomainRowSkeleton() {
  return (
    <div
      data-testid="domain-skeleton"
      className={cn(ROW_GRID, "py-3 px-5 animate-pulse")}
    >
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 shrink-0 rounded-lg bg-muted/50" />
        <div className="h-4 w-32 rounded bg-muted/50" />
      </div>
      <div className="h-4 w-24 rounded bg-muted/30" />
      <div className="h-4 w-16 rounded bg-muted/30" />
      <div className="h-5 w-16 rounded bg-muted/30" />
      <div />
    </div>
  );
}
