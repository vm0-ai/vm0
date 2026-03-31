import { useState } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
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
import {
  zeroOrgDomainsContract,
  type OrgDomain,
  type OrgEnrollmentMode,
} from "@vm0/core";
import { zeroClient$ } from "../../../../signals/api-client.ts";
import {
  orgDomains$,
  refreshOrgDomains$,
} from "../../../../signals/external/org-domains.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { extractApiErrorMessage } from "./org-api-error.ts";

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
  const createClient = useGet(zeroClient$);
  const refresh = useSet(refreshOrgDomains$);

  const domains =
    domainsLoadable.state === "hasData" ? domainsLoadable.data : [];
  const isLoading = domainsLoadable.state === "loading";

  const handleAdd = async (name: string, enrollmentMode: OrgEnrollmentMode) => {
    const client = createClient(zeroOrgDomainsContract);
    const result = await client.add({ body: { name, enrollmentMode } });
    if (result.status === 200) {
      toast.success(`Domain ${name} added`);
      refresh();
      return;
    }
    throw new Error(extractApiErrorMessage(result, "Failed to add domain"));
  };

  const handleRemove = async (domainId: string) => {
    const client = createClient(zeroOrgDomainsContract);
    const result = await client.remove({ body: { domainId } });
    if (result.status === 200) {
      toast.success("Domain removed");
      refresh();
      return;
    }
    throw new Error(extractApiErrorMessage(result, "Failed to remove domain"));
  };

  const handleSetVerified = async (domainId: string, verified: boolean) => {
    const client = createClient(zeroOrgDomainsContract);
    const result = await client.setVerified({ body: { domainId, verified } });
    if (result.status === 200) {
      toast.success(verified ? "Domain verified" : "Domain unverified");
      refresh();
      return;
    }
    throw new Error(extractApiErrorMessage(result, "Failed to update domain"));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <AddDomainDialog onAdd={handleAdd} />
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
                <DomainRow
                  domain={domain}
                  onRemove={handleRemove}
                  onSetVerified={handleSetVerified}
                />
              </div>
            );
          })}
      </div>
    </div>
  );
}

function AddDomainDialog({
  onAdd,
}: {
  onAdd: (name: string, enrollmentMode: OrgEnrollmentMode) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [enrollmentMode, setEnrollmentMode] =
    useState<OrgEnrollmentMode>("manual_invitation");
  const [adding, setAdding] = useState(false);

  const trimmed = name.trim().toLowerCase();
  const isValid =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      trimmed,
    );

  const handleAdd = () => {
    setAdding(true);
    detach(
      onAdd(trimmed, enrollmentMode).then(
        () => {
          setOpen(false);
          setName("");
          setEnrollmentMode("manual_invitation");
          setAdding(false);
        },
        (error: unknown) => {
          setAdding(false);
          const message =
            error instanceof Error ? error.message : "Failed to add domain";
          toast.error(message);
        },
      ),
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

function DomainRow({
  domain,
  onRemove,
  onSetVerified,
}: {
  domain: OrgDomain;
  onRemove: (domainId: string) => Promise<void>;
  onSetVerified: (domainId: string, verified: boolean) => Promise<void>;
}) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [settingVerified, setSettingVerified] = useState(false);
  const isVerified = domain.verification.status === "verified";

  const handleRemove = () => {
    setRemoving(true);
    detach(
      onRemove(domain.id).then(
        () => {
          setRemoveOpen(false);
          setRemoving(false);
        },
        (error: unknown) => {
          setRemoving(false);
          const message =
            error instanceof Error ? error.message : "Failed to remove domain";
          toast.error(message);
        },
      ),
      Reason.DomCallback,
    );
  };

  const handleSetVerified = (verified: boolean) => {
    setSettingVerified(true);
    detach(
      onSetVerified(domain.id, verified).then(
        () => {
          return setSettingVerified(false);
        },
        (error: unknown) => {
          setSettingVerified(false);
          const message =
            error instanceof Error ? error.message : "Failed to update domain";
          toast.error(message);
        },
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className={cn(ROW_GRID, "py-3 px-5")}>
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
              setRemoveOpen(v);
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
                  return setRemoveOpen(true);
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
                  return setRemoveOpen(false);
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
    <div className={cn(ROW_GRID, "py-3 px-5 animate-pulse")}>
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
