// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useLoadable, useGet, useSet } from "ccstate-react";
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
} from "@vm0/api-contracts/contracts/zero-org";
import type { OrgResponse } from "@vm0/api-contracts/contracts/orgs";
import { org$, isOrgAdmin$, refreshOrg$ } from "../../../../signals/org.ts";
import { clerk$, resolveWebOrigin } from "../../../../signals/auth.ts";
import { zeroClient$ } from "../../../../signals/api-client.ts";
import { fetch$ } from "../../../../signals/fetch.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
  settle,
} from "../../../../signals/utils.ts";
import {
  profileName$,
  setProfileName$,
  profileSlug$,
  setProfileSlug$,
  profileSaving$,
  setProfileSaving$,
  profileLogoUrl$,
  setProfileLogoUrl$,
  pendingLogoFile$,
  setPendingLogoFile$,
  pendingLogoPreview$,
  setPendingLogoPreview$,
  fileInputEl$,
  setFileInputEl$,
  logoLoaded$,
  setLogoLoaded$,
  leaving$,
  setLeaving$,
  deleting$,
  setDeleting$,
  deleteConfirm$,
  setDeleteConfirm$,
  saveError$,
  setSaveError$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";
import { readImageDimensions } from "./read-image-dimensions.ts";

const sectionCardStyle = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

const MIN_LOGO_DIMENSION = 100;
const MAX_LOGO_DIMENSION = 4096;

function extractErrorMessage(
  result: { status: number; body: unknown },
  fallback: string,
): string {
  const body = result.body as { error?: { message?: string } } | undefined;
  return body?.error?.message ?? fallback;
}

async function uploadLogo(
  fetchFn: typeof fetch,
  file: File,
): Promise<{ logoUrl: string | null } | null> {
  const formData = new FormData();
  formData.append("file", file);
  const resp = await fetchFn("/api/zero/org/logo", {
    method: "POST",
    body: formData,
  });
  if (!resp.ok) {
    const settled = await settle(resp.json());
    const data = settled.ok
      ? (settled.value as { error?: { message?: string } } | null)
      : null;
    toast.error(data?.error?.message ?? "Failed to upload logo");
    return null;
  }
  return (await resp.json()) as { logoUrl: string | null };
}

function ProfileSection({
  org,
  isAdmin,
}: {
  org: OrgResponse;
  isAdmin: boolean;
}) {
  const name = useGet(profileName$);
  const setName = useSet(setProfileName$);

  const slug = useGet(profileSlug$);
  const setSlug = useSet(setProfileSlug$);

  const saving = useGet(profileSaving$);
  const setSaving = useSet(setProfileSaving$);

  const logoUrl = useGet(profileLogoUrl$);
  const setLogoUrl = useSet(setProfileLogoUrl$);

  const pendingLogoFile = useGet(pendingLogoFile$);
  const setPendingLogoFile = useSet(setPendingLogoFile$);

  const pendingLogoPreview = useGet(pendingLogoPreview$);
  const setPendingLogoPreview = useSet(setPendingLogoPreview$);

  const fileInputEl = useGet(fileInputEl$);
  const setFileInputEl = useSet(setFileInputEl$);

  const fetchFn = useGet(fetch$);
  const refreshOrg = useSet(refreshOrg$);
  const clerkLoadable = useLoadable(clerk$);
  const clerk =
    clerkLoadable.state === "hasData" ? clerkLoadable.data : undefined;

  const logoLoaded = useGet(logoLoaded$);
  const setLogoLoaded = useSet(setLogoLoaded$);

  const saveError = useGet(saveError$);
  const setSaveError = useSet(setSaveError$);

  const createClient = useGet(zeroClient$);
  const hasNameChange = name !== (org.name ?? "");
  const hasSlugChange = slug !== (org.slug ?? "");
  const hasChanges = hasNameChange || hasSlugChange || !!pendingLogoFile;

  const handleFileSelect = async (file: File) => {
    const dimensions = await readImageDimensions(file);
    if (!dimensions) {
      toast.error("Could not read image file");
      return;
    }
    const { width, height } = dimensions;
    if (width < MIN_LOGO_DIMENSION || height < MIN_LOGO_DIMENSION) {
      toast.error(
        `Logo is too small (${width}×${height}px). Minimum size is ${MIN_LOGO_DIMENSION}×${MIN_LOGO_DIMENSION}px.`,
      );
      return;
    }
    if (width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION) {
      toast.error(
        `Logo is too large (${width}×${height}px). Maximum size is ${MAX_LOGO_DIMENSION}×${MAX_LOGO_DIMENSION}px.`,
      );
      return;
    }
    setPendingLogoFile(file);
    setPendingLogoPreview(URL.createObjectURL(file));
  };

  const handleDiscard = () => {
    setName(org.name ?? "");
    setSlug(org.slug ?? "");
    if (pendingLogoPreview) {
      URL.revokeObjectURL(pendingLogoPreview);
    }
    setPendingLogoFile(null);
    setPendingLogoPreview(null);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!hasChanges || saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    const doSave = async () => {
      if (pendingLogoFile) {
        const result = await uploadLogo(fetchFn, pendingLogoFile);
        if (!result) {
          return;
        }
        setLogoUrl(result.logoUrl);
      }

      if (hasNameChange || hasSlugChange) {
        const client = createClient(zeroOrgContract);
        const body: { name?: string; slug?: string; force?: boolean } = {};
        if (hasNameChange) {
          body.name = name;
        }
        if (hasSlugChange) {
          body.slug = slug;
          body.force = true;
        }
        const result = await client.update({ body });
        if (result.status !== 200) {
          const message = extractErrorMessage(
            result,
            `Failed to update (${result.status})`,
          );
          setSaveError(message);
          return;
        }
      }

      if (pendingLogoPreview) {
        URL.revokeObjectURL(pendingLogoPreview);
      }
      setPendingLogoFile(null);
      setPendingLogoPreview(null);
      refreshOrg();
      await clerk?.organization?.reload();
      toast.success("Workspace updated");
    };
    await bestEffort(doSave());
    setSaving(false);
  };

  const handleLogoLoad = () => {
    if (logoLoaded) {
      return;
    }
    setLogoLoaded(true);
    detach(
      (async () => {
        const response = await fetchFn("/api/zero/org/logo");
        const data = (await response.json()) as { logoUrl: string | null };
        if (data.logoUrl) {
          setLogoUrl(data.logoUrl);
        }
      })(),
      Reason.DomCallback,
    );
  };

  return (
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
              Workspace avatar displayed across the app
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {isAdmin && (
              <input
                ref={setFileInputEl}
                type="file"
                aria-label="Upload logo"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    detach(handleFileSelect(file), Reason.DomCallback);
                  }
                  e.target.value = "";
                }}
              />
            )}
            <button
              type="button"
              ref={(el) => {
                if (el) {
                  handleLogoLoad();
                }
              }}
              className="group relative h-9 w-9 shrink-0 rounded-lg overflow-hidden"
              disabled={!isAdmin}
              onClick={() => {
                if (isAdmin) {
                  fileInputEl?.click();
                }
              }}
            >
              {(pendingLogoPreview ?? logoUrl) ? (
                <img
                  src={(pendingLogoPreview ?? logoUrl)!}
                  alt={org.slug ?? "Org"}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full bg-muted/50 animate-pulse" />
              )}
              {isAdmin && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                  <IconUpload size={14} stroke={2} className="text-white" />
                </div>
              )}
            </button>
          </div>
        </div>
        <div className="h-0 zero-border-t mx-5" />
        {/* Name row */}
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Name</p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              Used to identify this workspace
            </p>
          </div>
          {isAdmin ? (
            <Input
              id="org-name"
              value={name}
              onChange={(e) => {
                return setName(e.target.value);
              }}
              placeholder="Workspace name"
              className="w-[220px] shrink-0"
            />
          ) : (
            <span className="text-sm text-foreground shrink-0">
              {org.name ?? ""}
            </span>
          )}
        </div>
        <div className="h-0 zero-border-t mx-5" />
        {/* Slug row */}
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Slug</p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              URL-friendly identifier for the organization
            </p>
          </div>
          {isAdmin ? (
            <Input
              id="org-slug"
              value={slug}
              onChange={(e) => {
                return setSlug(e.target.value);
              }}
              placeholder="organization-slug"
              className="w-[220px] shrink-0"
            />
          ) : (
            <span className="text-sm text-foreground shrink-0">
              {org.slug ?? ""}
            </span>
          )}
        </div>
      </div>

      {hasChanges && isAdmin && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="rounded-lg"
              onClick={onDomEventFn(handleSave)}
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
          {saveError && (
            <p className="text-[13px] text-destructive">{saveError}</p>
          )}
        </div>
      )}
    </section>
  );
}

function DangerZoneSection({
  org,
  isAdmin,
}: {
  org: OrgResponse;
  isAdmin: boolean;
}) {
  const createClient = useGet(zeroClient$);
  const clerkLoadable = useLoadable(clerk$);
  const clerk =
    clerkLoadable.state === "hasData" ? clerkLoadable.data : undefined;
  const canLeave = !isAdmin;

  const leaving = useGet(leaving$);
  const setLeaving = useSet(setLeaving$);

  const deleting = useGet(deleting$);
  const setDeleting = useSet(setDeleting$);

  const deleteConfirm = useGet(deleteConfirm$);
  const setDeleteConfirm = useSet(setDeleteConfirm$);

  const handleLeave = async () => {
    if (leaving) {
      return;
    }
    setLeaving(true);
    const client = createClient(zeroOrgLeaveContract);
    await bestEffort(
      (async () => {
        const result = await client.leave({ body: {} });
        if (result.status === 200) {
          // Clear the active organization before navigating so the session
          // JWT no longer references an org the user is no longer a member
          // of; otherwise Clerk may revoke the session and log the user out.
          await clerk?.setActive({ organization: null });
          toast.success("You have left the workspace");
          window.location.href = `${resolveWebOrigin()}/sign-in/tasks/choose-organization`;
        } else {
          toast.error(
            extractErrorMessage(result, `Failed to leave (${result.status})`),
          );
        }
      })(),
    );
    setLeaving(false);
  };

  const handleDelete = async () => {
    if (deleting || deleteConfirm !== org.slug) {
      return;
    }
    setDeleting(true);
    const client = createClient(zeroOrgDeleteContract);
    await bestEffort(
      (async () => {
        const result = await client.delete({ body: { slug: org.slug } });
        if (result.status === 200) {
          // Clear the active organization before navigating so the session
          // JWT no longer references the deleted org; otherwise Clerk may
          // revoke the session and log the user out.
          await clerk?.setActive({ organization: null });
          toast.success("Workspace deleted");
          window.location.href = `${resolveWebOrigin()}/sign-in/tasks/choose-organization`;
        } else {
          toast.error(
            extractErrorMessage(result, `Failed to delete (${result.status})`),
          );
        }
      })(),
    );
    setDeleting(false);
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Danger zone</h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={sectionCardStyle}
      >
        {canLeave && (
          <>
            {/* Leave workspace */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  Leave workspace
                </p>
                <p className="text-[13px] text-muted-foreground mt-0.5">
                  You will lose access to this workspace and its resources.
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
                    <DialogTitle>Leave workspace?</DialogTitle>
                    <DialogDescription>
                      You will no longer have access to this workspace. You can
                      rejoin only if an admin invites you again.
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
                      onClick={onDomEventFn(handleLeave)}
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
            {canLeave && <div className="h-0 zero-border-t mx-5" />}
            {/* Delete workspace */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  Delete workspace
                </p>
                <p className="text-[13px] text-muted-foreground mt-0.5">
                  Permanently delete this workspace and all its data. This
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
                    <DialogTitle>Delete workspace?</DialogTitle>
                    <DialogDescription>
                      This will permanently delete{" "}
                      <span className="font-semibold text-foreground">
                        {org.slug}
                      </span>{" "}
                      and all its data. This action cannot be undone. Type the
                      workspace name to confirm.
                    </DialogDescription>
                  </DialogHeader>
                  <Input
                    placeholder={org.slug}
                    value={deleteConfirm}
                    onChange={(e) => {
                      return setDeleteConfirm(e.target.value);
                    }}
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
                      onClick={onDomEventFn(handleDelete)}
                      disabled={deleting || deleteConfirm !== org.slug}
                    >
                      {deleting ? "Deleting..." : "Delete workspace"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function OrgGeneralTab() {
  const orgLoadable = useLoadable(org$);
  const org = orgLoadable.state === "hasData" ? orgLoadable.data : undefined;
  const isLoading = orgLoadable.state === "loading";
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  if (isLoading || !org) {
    return <GeneralTabSkeleton />;
  }

  return (
    <div className="flex flex-col gap-8">
      <ProfileSection org={org} isAdmin={isAdmin} />
      <DangerZoneSection org={org} isAdmin={isAdmin} />
    </div>
  );
}

function GeneralTabSkeleton() {
  return (
    <div className="flex flex-col gap-8" role="status" aria-label="Loading">
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
          <div className="h-0 zero-border-t mx-5" />
          {/* Name row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="h-4 w-10 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-40 rounded bg-muted/30 animate-pulse mt-1.5" />
            </div>
            <div className="h-9 w-[220px] shrink-0 rounded-lg bg-muted/30 animate-pulse" />
          </div>
          <div className="h-0 zero-border-t mx-5" />
          {/* Slug row */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="h-4 w-8 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-52 rounded bg-muted/30 animate-pulse mt-1.5" />
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
