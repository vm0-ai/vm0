import { useRef } from "react";
import { useLoadable, useGet, useSet } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
import { IconUpload } from "@tabler/icons-react";
import {
  Input,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroOrgContract,
  zeroOrgLeaveContract,
  zeroOrgDeleteContract,
} from "@vm0/core";
import { org$, isOrgAdmin$, refreshOrg$ } from "../../../../signals/org.ts";
import { clerk$ } from "../../../../signals/auth.ts";
import { zeroClient$ } from "../../../../signals/api-client.ts";
import { fetch$ } from "../../../../signals/fetch.ts";

const sectionCardStyle = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

export function OrgGeneralTab() {
  const orgLoadable = useLoadable(org$);
  const org = orgLoadable.state === "hasData" ? orgLoadable.data : undefined;
  const isLoading = orgLoadable.state === "loading";
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  const canLeave = !isAdmin;

  const name$ = useCCState(org?.name ?? "");
  const name = useGet(name$);
  const setName = useSet(name$);

  const saving$ = useCCState(false);
  const saving = useGet(saving$);
  const setSaving = useSet(saving$);

  const leaving$ = useCCState(false);
  const leaving = useGet(leaving$);
  const setLeaving = useSet(leaving$);

  const deleting$ = useCCState(false);
  const deleting = useGet(deleting$);
  const setDeleting = useSet(deleting$);

  const deleteConfirm$ = useCCState("");
  const deleteConfirm = useGet(deleteConfirm$);
  const setDeleteConfirm = useSet(deleteConfirm$);

  const logoUrl$ = useCCState<string | null>(null);
  const logoUrl = useGet(logoUrl$);
  const setLogoUrl = useSet(logoUrl$);

  const pendingLogoFile$ = useCCState<File | null>(null);
  const pendingLogoFile = useGet(pendingLogoFile$);
  const setPendingLogoFile = useSet(pendingLogoFile$);

  const pendingLogoPreview$ = useCCState<string | null>(null);
  const pendingLogoPreview = useGet(pendingLogoPreview$);
  const setPendingLogoPreview = useSet(pendingLogoPreview$);

  const logoLoaded$ = useCCState(false);
  const logoLoaded = useGet(logoLoaded$);
  const setLogoLoaded = useSet(logoLoaded$);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const fetchFn = useGet(fetch$);
  const refreshOrg = useSet(refreshOrg$);
  const clerkLoadable = useLoadable(clerk$);
  const clerk =
    clerkLoadable.state === "hasData" ? clerkLoadable.data : undefined;

  const prevName$ = useCCState<string | undefined>(undefined);
  const prevName = useGet(prevName$);
  const setPrevName = useSet(prevName$);
  if (org?.name && prevName !== org.name) {
    setPrevName(org.name);
    setName(org.name);
  }

  // Fetch logo URL on mount
  if (org && !logoLoaded) {
    setLogoLoaded(true);
    fetchFn("/api/zero/org/logo")
      .then((r) => r.json())
      .then((data: { logoUrl: string | null }) => {
        if (data.logoUrl) setLogoUrl(data.logoUrl);
      })
      .catch(() => {});
  }

  const createClient = useGet(zeroClient$);
  const hasNameChange = name !== (org?.name ?? "");
  const hasChanges = hasNameChange || !!pendingLogoFile;

  const handleFileSelect = (file: File) => {
    setPendingLogoFile(file);
    setPendingLogoPreview(URL.createObjectURL(file));
  };

  const handleDiscard = () => {
    setName(org?.name ?? "");
    if (pendingLogoPreview) URL.revokeObjectURL(pendingLogoPreview);
    setPendingLogoFile(null);
    setPendingLogoPreview(null);
  };

  const handleSave = async () => {
    if (!org || !hasChanges || saving) return;
    setSaving(true);
    try {
      // Upload logo if pending
      if (pendingLogoFile) {
        const formData = new FormData();
        formData.append("file", pendingLogoFile);
        const resp = await fetchFn("/api/zero/org/logo", {
          method: "POST",
          body: formData,
        });
        if (!resp.ok) {
          const data = (await resp.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          toast.error(data?.error?.message ?? "Failed to upload logo");
          setSaving(false);
          return;
        }
        const data = (await resp.json()) as { logoUrl: string | null };
        setLogoUrl(data.logoUrl);
      }

      // Update name if changed
      if (hasNameChange) {
        const client = createClient(zeroOrgContract);
        const result = await client.update({
          body: { name },
        });
        if (result.status !== 200) {
          const msg =
            result.status === 400 ||
            result.status === 401 ||
            result.status === 403 ||
            result.status === 404 ||
            result.status === 409 ||
            result.status === 500
              ? result.body.error.message
              : undefined;
          toast.error(msg ?? `Failed to update (${result.status})`);
          setSaving(false);
          return;
        }
      }

      // Clear pending state
      if (pendingLogoPreview) URL.revokeObjectURL(pendingLogoPreview);
      setPendingLogoFile(null);
      setPendingLogoPreview(null);

      // Refresh org signal so UI updates without reload
      refreshOrg();

      // Refresh Clerk organization so sidebar avatar updates
      await clerk?.organization?.reload();

      toast.success("Organization updated");
    } finally {
      setSaving(false);
    }
  };

  const handleLeave = async () => {
    if (!org || leaving) return;
    setLeaving(true);
    try {
      const client = createClient(zeroOrgLeaveContract);
      const result = await client.leave({ body: {} });
      if (result.status === 200) {
        toast.success("You have left the organization");
        window.location.reload();
      } else {
        const msg =
          result.status === 401 ||
          result.status === 403 ||
          result.status === 500
            ? result.body.error.message
            : undefined;
        toast.error(msg ?? `Failed to leave (${result.status})`);
      }
    } finally {
      setLeaving(false);
    }
  };

  const handleDelete = async () => {
    if (!org || deleting || deleteConfirm !== org.slug) return;
    setDeleting(true);
    try {
      const client = createClient(zeroOrgDeleteContract);
      const result = await client.delete({ body: { slug: org.slug } });
      if (result.status === 200) {
        toast.success("Organization deleted");
        window.location.reload();
      } else {
        const msg =
          result.status === 400 ||
          result.status === 401 ||
          result.status === 403 ||
          result.status === 500
            ? result.body.error.message
            : undefined;
        toast.error(msg ?? `Failed to delete (${result.status})`);
      }
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return <GeneralTabSkeleton />;
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Profile section */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Profile</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          {/* Logo row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Logo</p>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                Organization avatar displayed across the app
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {isAdmin && (
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelect(file);
                    e.target.value = "";
                  }}
                />
              )}
              <button
                type="button"
                className="group relative h-9 w-9 shrink-0 rounded-lg overflow-hidden"
                disabled={!isAdmin}
                onClick={() => isAdmin && fileInputRef.current?.click()}
              >
                {(pendingLogoPreview ?? logoUrl) ? (
                  <img
                    src={(pendingLogoPreview ?? logoUrl)!}
                    alt={org?.slug ?? "Org"}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full bg-muted/50" />
                )}
                {isAdmin && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconUpload size={14} stroke={2} className="text-white" />
                  </div>
                )}
              </button>
            </div>
          </div>
          <div className="h-px bg-border/40 mx-5" />
          {/* Name row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Name</p>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                Used to identify this organization
              </p>
            </div>
            {isAdmin ? (
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Organization name"
                className="h-9 w-[220px] shrink-0 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))]"
              />
            ) : (
              <span className="text-sm text-foreground shrink-0">
                {org?.name ?? ""}
              </span>
            )}
          </div>
        </div>

        {hasChanges && isAdmin && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="rounded-lg"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save changes"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-muted-foreground"
              onClick={handleDiscard}
              disabled={saving}
            >
              Discard
            </Button>
          </div>
        )}
      </section>

      {/* Danger zone */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Danger zone</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          {canLeave && (
            <>
              {/* Leave organization */}
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    Leave organization
                  </p>
                  <p className="text-[13px] text-muted-foreground mt-0.5">
                    You will lose access to this organization and its resources.
                  </p>
                </div>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="shrink-0 gap-1.5"
                    >
                      Leave
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Leave organization?</DialogTitle>
                      <DialogDescription>
                        You will no longer have access to this organization. You
                        can rejoin only if an admin invites you again.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline" size="sm">
                          Cancel
                        </Button>
                      </DialogClose>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleLeave}
                        disabled={leaving}
                      >
                        {leaving ? "Leaving..." : "Leave"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </>
          )}
          {isAdmin && (
            <>
              {canLeave && <div className="h-px bg-border/40 mx-5" />}
              {/* Delete organization */}
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    Delete organization
                  </p>
                  <p className="text-[13px] text-muted-foreground mt-0.5">
                    Permanently delete this organization and all its data. This
                    action cannot be undone.
                  </p>
                </div>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="shrink-0 gap-1.5"
                    >
                      Delete
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Delete organization?</DialogTitle>
                      <DialogDescription>
                        This will permanently delete{" "}
                        <span className="font-semibold text-foreground">
                          {org?.slug}
                        </span>{" "}
                        and all its data. This action cannot be undone. Type the
                        organization name to confirm.
                      </DialogDescription>
                    </DialogHeader>
                    <Input
                      placeholder={org?.slug}
                      value={deleteConfirm}
                      onChange={(e) => setDeleteConfirm(e.target.value)}
                    />
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline" size="sm">
                          Cancel
                        </Button>
                      </DialogClose>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleDelete}
                        disabled={deleting || deleteConfirm !== org?.slug}
                      >
                        {deleting ? "Deleting..." : "Delete organization"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export function GeneralTabSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      {/* Profile section skeleton */}
      <section className="flex flex-col gap-3">
        <div className="h-4 w-12 rounded bg-muted/50 animate-pulse" />
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          {/* Logo row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="h-4 w-8 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-48 rounded bg-muted/30 animate-pulse mt-1.5" />
            </div>
            <div className="h-9 w-9 shrink-0 rounded-lg bg-muted/50 animate-pulse" />
          </div>
          <div className="h-px bg-border/40 mx-5" />
          {/* Name row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="h-4 w-10 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-40 rounded bg-muted/30 animate-pulse mt-1.5" />
            </div>
            <div className="h-9 w-[220px] shrink-0 rounded-lg bg-muted/30 animate-pulse" />
          </div>
        </div>
      </section>
      {/* Danger zone skeleton */}
      <section className="flex flex-col gap-3">
        <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="h-4 w-28 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-64 rounded bg-muted/30 animate-pulse mt-1.5" />
            </div>
            <div className="h-8 w-16 shrink-0 rounded-md bg-muted/30 animate-pulse" />
          </div>
        </div>
      </section>
    </div>
  );
}
