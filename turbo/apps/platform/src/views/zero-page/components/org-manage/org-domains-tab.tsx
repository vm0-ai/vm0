import { useState } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  IconPlus,
  IconTrash,
  IconCircleCheck,
  IconAlertCircle,
  IconWorldWww,
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
  Input,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroOrgDomainsContract, type OrgDomain } from "@vm0/core";
import { zeroClient$ } from "../../../../signals/api-client.ts";
import {
  orgDomains$,
  refreshOrgDomains$,
} from "../../../../signals/external/org-domains.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

const ROW_GRID = "grid grid-cols-[1fr_6rem_6rem_2rem] gap-x-4 items-center";

export function OrgDomainsTab() {
  const domainsLoadable = useLoadable(orgDomains$);
  const createClient = useGet(zeroClient$);
  const refresh = useSet(refreshOrgDomains$);

  const domains =
    domainsLoadable.state === "hasData" ? domainsLoadable.data : [];
  const isLoading = domainsLoadable.state === "loading";

  const handleAdd = async (name: string) => {
    const client = createClient(zeroOrgDomainsContract);
    const result = await client.add({ body: { name } });
    if (result.status === 200) {
      toast.success(`Domain ${name} added`);
      refresh();
      return;
    }
    const msg =
      result.status === 401 || result.status === 403 || result.status === 500
        ? result.body.error.message
        : undefined;
    toast.error(msg ?? `Failed to add domain (${result.status})`);
    throw new Error(msg ?? `Failed to add domain (${result.status})`);
  };

  const handleRemove = async (domainId: string) => {
    const client = createClient(zeroOrgDomainsContract);
    const result = await client.remove({ body: { domainId } });
    if (result.status === 200) {
      toast.success("Domain removed");
      refresh();
      return;
    }
    const msg =
      result.status === 401 || result.status === 403 || result.status === 500
        ? result.body.error.message
        : undefined;
    toast.error(msg ?? `Failed to remove domain (${result.status})`);
    throw new Error(msg ?? `Failed to remove domain (${result.status})`);
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
          domains.map((domain, i) => (
            <div key={domain.id}>
              {i > 0 && <div className="h-px bg-border/40 mx-5" />}
              <DomainRow domain={domain} onRemove={handleRemove} />
            </div>
          ))}
      </div>
    </div>
  );
}

function AddDomainDialog({
  onAdd,
}: {
  onAdd: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  const trimmed = name.trim().toLowerCase();
  const isValid =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
      trimmed,
    );

  const handleAdd = () => {
    setAdding(true);
    detach(
      onAdd(trimmed).then(
        () => {
          setOpen(false);
          setName("");
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
        <Input
          placeholder="example.com"
          value={name}
          disabled={adding}
          onChange={(e) => setName(e.target.value)}
        />
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
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
}: {
  domain: OrgDomain;
  onRemove: (domainId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const isVerified = domain.verification.status === "verified";

  const handleRemove = () => {
    setRemoving(true);
    detach(
      onRemove(domain.id).then(
        () => {
          setOpen(false);
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

  return (
    <div className={cn(ROW_GRID, "py-3 px-5")}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
          <IconWorldWww size={16} stroke={1.5} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {domain.name}
          </p>
          <p className="text-[12px] text-muted-foreground">
            {domain.enrollmentMode.replace(/_/g, " ")}
          </p>
        </div>
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
          open={open}
          onOpenChange={(v) => {
            if (!removing) {
              setOpen(v);
            }
          }}
        >
          <DialogTrigger asChild>
            <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors">
              <IconTrash size={14} stroke={1.5} />
            </button>
          </DialogTrigger>
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
                onClick={() => setOpen(false)}
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
        <div className="flex flex-col gap-1">
          <div className="h-4 w-32 rounded bg-muted/50" />
          <div className="h-3 w-20 rounded bg-muted/30" />
        </div>
      </div>
      <div className="h-4 w-20 rounded bg-muted/30" />
      <div className="h-5 w-16 rounded bg-muted/30" />
      <div />
    </div>
  );
}
