// TODO(#8609): split large components to comply with max-lines-per-function
// (128) and complexity (20). The mobile-native iOS Settings rewrite split
// most of the heavy lifting into helpers (`runBatchProfileSave`,
// `validateLogoFile`, `MobileProfileEditSheets`, `MobileFieldEditSheet`); the
// remaining complexity is JSX-ternary density across the desktop rows that
// survive in their original form.
// oxlint-disable max-lines-per-function
// oxlint-disable complexity
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
} from "@vm0/ui";
import {
  MobileDestructiveRow,
  MobileFieldEditSheet,
  MobileFieldRow,
  MobileLogoRow,
  MobileSectionFooter,
} from "./org-general-mobile-rows.tsx";
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
  generalEditingField$,
  setGeneralEditingField$,
  generalEditDraft$,
  setGeneralEditDraft$,
  leaveDialogOpen$,
  setLeaveDialogOpen$,
  deleteDialogOpen$,
  setDeleteDialogOpen$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";
import { isMobileViewport$ } from "../../../../signals/zero-page/mobile-viewport.ts";
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

// Validates logo dimensions and toasts the right error. Returns false when
// the file is rejected. Extracted out of ProfileSection so the outer
// component stays under the cyclomatic-complexity cap.
async function validateLogoFile(file: File): Promise<boolean> {
  const dimensions = await readImageDimensions(file);
  if (!dimensions) {
    toast.error("Could not read image file");
    return false;
  }
  const { width, height } = dimensions;
  if (width < MIN_LOGO_DIMENSION || height < MIN_LOGO_DIMENSION) {
    toast.error(
      `Logo is too small (${width}×${height}px). Minimum size is ${MIN_LOGO_DIMENSION}×${MIN_LOGO_DIMENSION}px.`,
    );
    return false;
  }
  if (width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION) {
    toast.error(
      `Logo is too large (${width}×${height}px). Maximum size is ${MAX_LOGO_DIMENSION}×${MAX_LOGO_DIMENSION}px.`,
    );
    return false;
  }
  return true;
}

// Body-only of the batch profile save. Extracted to a free function so
// ProfileSection's `handleSave` doesn't blow past the cyclomatic-complexity
// cap (the inner `doSave` was getting counted against the parent).
interface BatchProfileSaveArgs {
  readonly fetchFn: typeof fetch;
  readonly createClient: (contract: typeof zeroOrgContract) => {
    update: (args: {
      body: { name?: string; slug?: string; force?: boolean };
    }) => Promise<{ status: number; body: unknown }>;
  };
  readonly pendingLogoFile: File | null;
  readonly pendingLogoPreview: string | null;
  readonly hasNameChange: boolean;
  readonly hasSlugChange: boolean;
  readonly name: string;
  readonly slug: string;
  readonly setLogoUrl: (url: string | null) => void;
  readonly setPendingLogoFile: (file: File | null) => void;
  readonly setPendingLogoPreview: (preview: string | null) => void;
  readonly setSaveError: (message: string | null) => void;
  readonly refreshOrg: () => void;
  readonly reloadClerkOrg: () => Promise<unknown> | undefined;
}

async function runBatchProfileSave(args: BatchProfileSaveArgs): Promise<void> {
  if (args.pendingLogoFile) {
    const result = await uploadLogo(args.fetchFn, args.pendingLogoFile);
    if (!result) {
      return;
    }
    args.setLogoUrl(result.logoUrl);
  }
  if (args.hasNameChange || args.hasSlugChange) {
    const client = args.createClient(zeroOrgContract);
    const body: { name?: string; slug?: string; force?: boolean } = {};
    if (args.hasNameChange) {
      body.name = args.name;
    }
    if (args.hasSlugChange) {
      body.slug = args.slug;
      body.force = true;
    }
    const result = await client.update({ body });
    if (result.status !== 200) {
      args.setSaveError(
        extractErrorMessage(result, `Failed to update (${result.status})`),
      );
      return;
    }
  }
  if (args.pendingLogoPreview) {
    URL.revokeObjectURL(args.pendingLogoPreview);
  }
  args.setPendingLogoFile(null);
  args.setPendingLogoPreview(null);
  args.refreshOrg();
  await args.reloadClerkOrg();
  toast.success("Workspace updated");
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
    const data = (await resp.json().catch(() => {
      return null;
    })) as {
      error?: { message?: string };
    } | null;
    toast.error(data?.error?.message ?? "Failed to upload logo");
    return null;
  }
  return (await resp.json()) as { logoUrl: string | null };
}

function MobileProfileEditSheets({ org }: { readonly org: OrgResponse }) {
  // Self-contained sub-component for the per-field bottom-sheet editors.
  // Extracted out of ProfileSection because rendering both sheets inline
  // pushed the parent over the cyclomatic-complexity cap (max 20).
  const name = useGet(profileName$);
  const setName = useSet(setProfileName$);
  const slug = useGet(profileSlug$);
  const setSlug = useSet(setProfileSlug$);
  const saving = useGet(profileSaving$);
  const setSaving = useSet(setProfileSaving$);
  const saveError = useGet(saveError$);
  const setSaveError = useSet(setSaveError$);
  const editingField = useGet(generalEditingField$);
  const setEditingField = useSet(setGeneralEditingField$);
  const editDraft = useGet(generalEditDraft$);
  const setEditDraft = useSet(setGeneralEditDraft$);
  const refreshOrg = useSet(refreshOrg$);
  const createClient = useGet(zeroClient$);
  const clerkLoadable = useLoadable(clerk$);
  const clerk =
    clerkLoadable.state === "hasData" ? clerkLoadable.data : undefined;

  const saveField = async (
    field: "name" | "slug",
    nextValue: string,
  ): Promise<boolean> => {
    if (saving) {
      return false;
    }
    setSaving(true);
    setSaveError(null);
    let success = false;
    await bestEffort(
      (async () => {
        const client = createClient(zeroOrgContract);
        const body: { name?: string; slug?: string; force?: boolean } =
          field === "name"
            ? { name: nextValue }
            : { slug: nextValue, force: true };
        const result = await client.update({ body });
        if (result.status !== 200) {
          setSaveError(
            extractErrorMessage(result, `Failed to update (${result.status})`),
          );
          return;
        }
        if (field === "name") {
          setName(nextValue);
        } else {
          setSlug(nextValue);
        }
        refreshOrg();
        await clerk?.organization?.reload();
        toast.success("Workspace updated");
        success = true;
      })(),
    );
    setSaving(false);
    return success;
  };

  const handleClose = () => {
    setEditingField(null);
    setSaveError(null);
  };

  const initialValue =
    editingField === "name" ? name : editingField === "slug" ? slug : "";

  return (
    <MobileFieldEditSheet
      open={editingField !== null}
      onOpenChange={(open) => {
        if (!open) {
          handleClose();
        }
      }}
      label={editingField === "slug" ? "Slug" : "Name"}
      description={
        editingField === "slug"
          ? "URL-friendly identifier for the organization."
          : "Used to identify this workspace."
      }
      placeholder={
        editingField === "slug" ? "organization-slug" : "Workspace name"
      }
      draft={editDraft}
      onDraftChange={setEditDraft}
      initialValue={initialValue}
      saving={saving}
      errorMessage={saveError}
      onSave={(next) => {
        if (editingField === null) {
          return Promise.resolve(false);
        }
        return saveField(editingField, next);
      }}
    />
  );
  // Reference org so the closure picks up the current value when
  // `saveField` succeeds and `refreshOrg` mutates the loadable.
  void org;
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

  // Mobile-only state: setters used by the iOS-style row triggers below.
  // The actual sheet rendering + per-field save logic lives in
  // `<MobileProfileEditSheets>` to keep this component under the
  // cyclomatic-complexity cap.
  const isMobile = useGet(isMobileViewport$);
  const setEditingField = useSet(setGeneralEditingField$);
  const setEditDraft = useSet(setGeneralEditDraft$);

  const handleFileSelect = async (file: File) => {
    if (!(await validateLogoFile(file))) {
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
    await bestEffort(
      runBatchProfileSave({
        fetchFn,
        createClient,
        pendingLogoFile,
        pendingLogoPreview,
        hasNameChange,
        hasSlugChange,
        name,
        slug,
        setLogoUrl,
        setPendingLogoFile,
        setPendingLogoPreview,
        setSaveError,
        refreshOrg,
        reloadClerkOrg: () => {
          return clerk?.organization?.reload();
        },
      }),
    );
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
        {/* Hidden file input shared between desktop + mobile triggers */}
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

        {/* Switch between iOS Settings-style mobile rows and the desktop
            inline-input row layout based on viewport. Conditional rendering
            (instead of CSS hiding) keeps the test queries unambiguous and
            avoids the duplicate-DOM cost. */}
        {isMobile ? (
          <>
            <div
              ref={(el) => {
                if (el) {
                  handleLogoLoad();
                }
              }}
            >
              <MobileLogoRow
                logoSrc={pendingLogoPreview ?? logoUrl}
                slug={org.slug}
                canEdit={isAdmin}
                onPick={() => {
                  if (isAdmin) {
                    fileInputEl?.click();
                  }
                }}
              />
            </div>
            <div className="h-0 zero-border-t mx-5" />
            <MobileFieldRow
              label="Name"
              value={isAdmin ? name : (org.name ?? "")}
              disabled={!isAdmin}
              onClick={() => {
                setEditDraft(name);
                setEditingField("name");
              }}
            />
            <div className="h-0 zero-border-t mx-5" />
            <MobileFieldRow
              label="Slug"
              value={isAdmin ? slug : (org.slug ?? "")}
              disabled={!isAdmin}
              onClick={() => {
                setEditDraft(slug);
                setEditingField("slug");
              }}
            />
          </>
        ) : (
          <>
            {/* Logo row — desktop */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Logo</p>
                <p className="text-[14px] text-muted-foreground mt-0.5">
                  Workspace avatar displayed across the app
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
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
            {/* Name row — desktop */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Name</p>
                <p className="text-[14px] text-muted-foreground mt-0.5">
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
            {/* Slug row — desktop */}
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Slug</p>
                <p className="text-[14px] text-muted-foreground mt-0.5">
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
          </>
        )}
      </div>

      {isMobile && (
        <MobileSectionFooter>
          Tap a field to edit. Slug is the URL-friendly identifier and is used
          in workspace links.
        </MobileSectionFooter>
      )}

      {hasChanges && isAdmin && (
        <div className="flex flex-col gap-1.5">
          {/* Mobile bumps the buttons to a comfortable tap size; on mobile
              this bar effectively only appears for pending logo uploads
              since name/slug commit through the per-field sheet. */}
          <div className="flex items-center gap-2 max-md:gap-2">
            <Button
              size="sm"
              className="rounded-lg max-md:flex-1"
              onClick={onDomEventFn(handleSave)}
              disabled={saving}
            >
              {saving ? "Saving..." : "Save changes"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-muted-foreground max-md:flex-1"
              onClick={handleDiscard}
              disabled={saving}
            >
              Discard
            </Button>
          </div>
          {saveError && (
            <p className="text-[14px] text-destructive">{saveError}</p>
          )}
        </div>
      )}

      {/* Mobile-only edit sheets — both sheets share one component since
          the sheet shape is identical and only one is open at a time. */}
      <MobileProfileEditSheets org={org} />
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

  const isMobile = useGet(isMobileViewport$);

  // Lifted Dialog open state so the same Dialog instance can be opened by
  // either the desktop "Leave/Delete" button or the mobile destructive list
  // row. Without this lift the mobile row would need its own Dialog clone.
  // Lives in ccstate signals because `useState` is restricted in this
  // codebase (see no-restricted-imports for "react").
  const leaveOpen = useGet(leaveDialogOpen$);
  const setLeaveOpen = useSet(setLeaveDialogOpen$);
  const deleteOpen = useGet(deleteDialogOpen$);
  const setDeleteOpen = useSet(setDeleteDialogOpen$);

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
        {canLeave &&
          (isMobile ? (
            <MobileDestructiveRow
              label="Leave workspace"
              onClick={() => {
                setLeaveOpen(true);
              }}
            />
          ) : (
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  Leave workspace
                </p>
                <p className="text-[14px] text-muted-foreground mt-0.5">
                  You will lose access to this workspace and its resources.
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0 gap-1.5"
                onClick={() => {
                  setLeaveOpen(true);
                }}
              >
                Leave
              </Button>
            </div>
          ))}
        {isAdmin && (
          <>
            {canLeave && <div className="h-0 zero-border-t mx-5" />}
            {isMobile ? (
              <MobileDestructiveRow
                label="Delete workspace"
                onClick={() => {
                  setDeleteOpen(true);
                }}
              />
            ) : (
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    Delete workspace
                  </p>
                  <p className="text-[14px] text-muted-foreground mt-0.5">
                    Permanently delete this workspace and all its data. This
                    action cannot be undone.
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={() => {
                    setDeleteOpen(true);
                  }}
                >
                  Delete
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {isMobile && (
        <MobileSectionFooter>
          {isAdmin
            ? "Delete is permanent. You'll be asked to type the workspace name to confirm."
            : "Leaving is permanent. An admin must reinvite you to rejoin."}
        </MobileSectionFooter>
      )}

      {/* Shared confirmation dialogs — same instance opens from desktop or
          mobile triggers via lifted open state. */}
      {canLeave && (
        <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Leave workspace?</DialogTitle>
              <DialogDescription>
                You will no longer have access to this workspace. You can rejoin
                only if an admin invites you again.
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
      )}
      {isAdmin && (
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
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
              className="max-md:h-12 max-md:text-[16px]"
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
      )}
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
