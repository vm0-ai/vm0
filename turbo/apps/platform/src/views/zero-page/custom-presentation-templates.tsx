import type { FormEvent } from "react";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import {
  IconArchive,
  IconCheck,
  IconHistory,
  IconLoader2,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconUsers,
} from "@tabler/icons-react";
import { Button, Input, cn } from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { useGet, useLastResolved, useSet } from "ccstate-react";

import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  activatePresentationTemplateRevision$,
  archivePresentationTemplate$,
  createPresentationTemplate$,
  deletePresentationTemplate$,
  presentationTemplateCatalog$,
  presentationTemplateCatalogRef$,
  presentationTemplateDeleteTarget$,
  presentationTemplateEditDraft$,
  presentationTemplatePollingRef$,
  presentationTemplateUploadDraft$,
  replacePresentationTemplateSource$,
  retryPresentationTemplateImport$,
  setPresentationTemplateDeleteTarget$,
  setPresentationTemplateEditDraft$,
  setPresentationTemplateUploadDraft$,
  updatePresentationTemplate$,
  type PresentationTemplateCatalogItem,
} from "../../signals/zero-page/presentation-templates.ts";
import { detach, Reason } from "../../signals/utils.ts";

function templateSelection(
  item: PresentationTemplateCatalogItem,
): GenerationTemplateRequest | null {
  const revision = item.template.activeRevision;
  if (!revision || item.template.archivedAt) {
    return null;
  }
  return {
    type: "presentation",
    selection: {
      kind: "custom",
      templateId: item.template.id,
      templateRevisionId: revision.id,
    },
  };
}

function statusLabel(item: PresentationTemplateCatalogItem): string {
  const latestImport = item.template.latestImport;
  if (latestImport?.status === "failed") {
    return latestImport.errorMessage ?? "Analysis failed";
  }
  if (
    latestImport?.status === "uploading" ||
    latestImport?.status === "queued" ||
    latestImport?.status === "processing"
  ) {
    return "Analyzing PowerPoint…";
  }
  if (item.template.archivedAt) {
    return "Archived";
  }
  return item.template.activeRevision
    ? `Version ${item.template.activeRevision.revisionNumber}`
    : "Upload a PowerPoint to finish setup";
}

function run(promise: Promise<void>, description: string): void {
  detach(promise, Reason.DomCallback, description);
}

function UploadFileButton({ templateId }: { readonly templateId?: string }) {
  const setUploadDraft = useSet(setPresentationTemplateUploadDraft$);
  return (
    <Button asChild size="sm" variant={templateId ? "outline" : "default"}>
      <label className="cursor-pointer">
        {templateId ? <IconRefresh size={14} /> : <IconUpload size={15} />}
        {templateId ? "Replace" : "Upload .pptx"}
        <input
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          className="hidden"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) {
              return;
            }
            setUploadDraft({
              file,
              mode: templateId ? "replace" : "create",
              ...(templateId ? { templateId } : {}),
              name: templateId ? "" : file.name.replace(/\.pptx$/i, ""),
              description: "",
              rightsConfirmed: false,
            });
          }}
        />
      </label>
    </Button>
  );
}

function TemplatePreview({
  item,
  selected,
  onSelect,
}: {
  readonly item: PresentationTemplateCatalogItem;
  readonly selected: boolean;
  readonly onSelect: (value: GenerationTemplateRequest) => void;
}) {
  const selection = templateSelection(item);
  const status = item.template.latestImport?.status;
  return (
    <button
      type="button"
      disabled={!selection}
      className="block w-full text-left disabled:cursor-default"
      onClick={() => {
        if (selection) {
          onSelect(selection);
        }
      }}
    >
      <div className="flex aspect-video items-center justify-center bg-muted">
        {item.previewUrl ? (
          <img
            src={item.previewUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : status === "processing" || status === "queued" ? (
          <IconLoader2 className="animate-spin text-muted-foreground" />
        ) : (
          <IconUpload className="text-muted-foreground" />
        )}
      </div>
      <div className="space-y-1 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {item.template.name}
          </span>
          {selected && <IconCheck size={15} className="text-primary" />}
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {statusLabel(item)}
        </p>
      </div>
    </button>
  );
}

function TemplateActionButtons({
  item,
}: {
  readonly item: PresentationTemplateCatalogItem;
}) {
  const pageSignal = useGet(pageSignal$);
  const updateTemplate = useSet(updatePresentationTemplate$);
  const archiveTemplate = useSet(archivePresentationTemplate$);
  const setEditDraft = useSet(setPresentationTemplateEditDraft$);
  const setDeleteTarget = useSet(setPresentationTemplateDeleteTarget$);
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setEditDraft({
            templateId: item.template.id,
            name: item.template.name,
            description: item.template.description ?? "",
          });
        }}
      >
        <IconPencil size={14} /> Edit
      </Button>
      <UploadFileButton templateId={item.template.id} />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          run(
            updateTemplate(
              {
                templateId: item.template.id,
                accessScope:
                  item.template.accessScope === "private"
                    ? "organization"
                    : "private",
              },
              pageSignal,
            ),
            "update presentation template access scope",
          );
        }}
      >
        <IconUsers size={14} />
        {item.template.accessScope === "private" ? "Share" : "Private"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          run(
            archiveTemplate(
              {
                templateId: item.template.id,
                archived: !item.template.archivedAt,
              },
              pageSignal,
            ),
            "archive presentation template",
          );
        }}
      >
        <IconArchive size={14} />
        {item.template.archivedAt ? "Restore" : "Archive"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="text-destructive"
        onClick={() => {
          setDeleteTarget({
            templateId: item.template.id,
            name: item.template.name,
          });
        }}
      >
        <IconTrash size={14} /> Delete
      </Button>
    </div>
  );
}

function TemplateRetry({
  item,
}: {
  readonly item: PresentationTemplateCatalogItem;
}) {
  const pageSignal = useGet(pageSignal$);
  const retryImport = useSet(retryPresentationTemplateImport$);
  const latestImport = item.template.latestImport;
  if (latestImport?.status !== "failed" || !latestImport.canRetry) {
    return null;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={() => {
        run(
          retryImport(
            { templateId: item.template.id, importId: latestImport.id },
            pageSignal,
          ),
          "retry presentation template import",
        );
      }}
    >
      Retry analysis
    </Button>
  );
}

function TemplateVersions({
  item,
}: {
  readonly item: PresentationTemplateCatalogItem;
}) {
  const pageSignal = useGet(pageSignal$);
  const activateRevision = useSet(activatePresentationTemplateRevision$);
  if (item.revisions.length <= 1) {
    return null;
  }
  return (
    <details className="text-xs">
      <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
        <IconHistory size={14} /> Version history
      </summary>
      <div className="mt-2 space-y-1">
        {item.revisions.map((revision) => {
          const active = revision.id === item.template.activeRevision?.id;
          return (
            <div
              key={revision.id}
              className="flex items-center justify-between rounded-md bg-muted/60 px-2 py-1.5"
            >
              <span>
                Version {revision.revisionNumber} · {revision.slideCount} slides
              </span>
              {!active && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    run(
                      activateRevision(
                        {
                          templateId: item.template.id,
                          revisionId: revision.id,
                        },
                        pageSignal,
                      ),
                      "activate presentation template revision",
                    );
                  }}
                >
                  Use this version
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function CustomTemplateCard({
  item,
  selected,
  onSelect,
}: {
  readonly item: PresentationTemplateCatalogItem;
  readonly selected: boolean;
  readonly onSelect: (value: GenerationTemplateRequest) => void;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        selected && "border-primary ring-1 ring-primary",
        item.template.archivedAt && "opacity-70",
      )}
    >
      <TemplatePreview item={item} selected={selected} onSelect={onSelect} />
      {item.template.canManage && (
        <div className="space-y-2 border-t px-3 py-2">
          <TemplateActionButtons item={item} />
          <TemplateRetry item={item} />
          <TemplateVersions item={item} />
        </div>
      )}
    </div>
  );
}

function UploadTemplateDialog() {
  const draft = useGet(presentationTemplateUploadDraft$);
  const pageSignal = useGet(pageSignal$);
  const setDraft = useSet(setPresentationTemplateUploadDraft$);
  const createTemplate = useSet(createPresentationTemplate$);
  const replaceSource = useSet(replacePresentationTemplateSource$);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !draft.rightsConfirmed) {
      return;
    }
    const promise =
      draft.mode === "replace" && draft.templateId
        ? replaceSource(
            { templateId: draft.templateId, file: draft.file },
            pageSignal,
          )
        : createTemplate(
            {
              name: draft.name.trim(),
              description: draft.description.trim() || undefined,
              file: draft.file,
            },
            pageSignal,
          );
    run(promise, "upload presentation template");
    setDraft(null);
  };
  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) {
          setDraft(null);
        }
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {draft?.mode === "replace"
                ? "Replace PowerPoint source"
                : "Create presentation template"}
            </DialogTitle>
            <DialogDescription>
              vm0 analyzes visual style and reusable brand assets. Slide copy,
              notes, comments, and hidden-slide content are excluded from the
              reusable runtime package.
            </DialogDescription>
          </DialogHeader>
          {draft?.mode === "create" && (
            <>
              <Input
                required
                value={draft.name}
                maxLength={256}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
                placeholder="Template name"
              />
              <Input
                value={draft.description}
                maxLength={2000}
                onChange={(event) => {
                  setDraft({ ...draft, description: event.target.value });
                }}
                placeholder="Description (optional)"
              />
            </>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft?.rightsConfirmed ?? false}
              onChange={(event) => {
                if (draft) {
                  setDraft({ ...draft, rightsConfirmed: event.target.checked });
                }
              }}
            />
            <span>
              I confirm I can use the visual identity, logos, and brand assets
              in this file as a reusable template.
            </span>
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDraft(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !draft?.rightsConfirmed ||
                (draft.mode === "create" && !draft.name.trim())
              }
            >
              Upload and analyze
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditTemplateDialog() {
  const draft = useGet(presentationTemplateEditDraft$);
  const pageSignal = useGet(pageSignal$);
  const setDraft = useSet(setPresentationTemplateEditDraft$);
  const updateTemplate = useSet(updatePresentationTemplate$);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft?.name.trim()) {
      return;
    }
    run(
      updateTemplate(
        {
          templateId: draft.templateId,
          name: draft.name.trim(),
          description: draft.description.trim() || null,
        },
        pageSignal,
      ),
      "update presentation template metadata",
    );
    setDraft(null);
  };
  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) {
          setDraft(null);
        }
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Edit presentation template</DialogTitle>
            <DialogDescription>
              Metadata changes do not create a new template version.
            </DialogDescription>
          </DialogHeader>
          <Input
            required
            value={draft?.name ?? ""}
            maxLength={256}
            onChange={(event) => {
              if (draft) {
                setDraft({ ...draft, name: event.target.value });
              }
            }}
            placeholder="Template name"
          />
          <Input
            value={draft?.description ?? ""}
            maxLength={2000}
            onChange={(event) => {
              if (draft) {
                setDraft({ ...draft, description: event.target.value });
              }
            }}
            placeholder="Description (optional)"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDraft(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!draft?.name.trim()}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTemplateDialog() {
  const target = useGet(presentationTemplateDeleteTarget$);
  const pageSignal = useGet(pageSignal$);
  const setTarget = useSet(setPresentationTemplateDeleteTarget$);
  const deleteTemplate = useSet(deletePresentationTemplate$);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          setTarget(null);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {target?.name ?? "this template"}?</DialogTitle>
          <DialogDescription>
            It will disappear from My templates. Existing runs keep their pinned
            version, but deleted templates cannot be selected for new messages.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setTarget(null);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (target) {
                run(
                  deleteTemplate(target.templateId, pageSignal),
                  "delete presentation template",
                );
                setTarget(null);
              }
            }}
          >
            Delete template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function catalogHasActiveImport(
  catalog: readonly PresentationTemplateCatalogItem[],
): boolean {
  return catalog.some((item) => {
    const status = item.template.latestImport?.status;
    return (
      status === "uploading" || status === "queued" || status === "processing"
    );
  });
}

export function CustomPresentationTemplates({
  value,
  onSelect,
}: {
  readonly value: GenerationTemplateRequest | undefined;
  readonly onSelect: (value: GenerationTemplateRequest) => void;
}) {
  const catalog = useLastResolved(presentationTemplateCatalog$) ?? [];
  const catalogRef = useSet(presentationTemplateCatalogRef$);
  const pollingRef = useSet(presentationTemplatePollingRef$);
  const selectedTemplateId =
    value?.type === "presentation" && value.selection.kind === "custom"
      ? value.selection.templateId
      : null;
  return (
    <section className="mb-6 space-y-3">
      <span ref={catalogRef} hidden />
      {catalogHasActiveImport(catalog) && <span ref={pollingRef} hidden />}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">My templates</h3>
          <p className="text-xs text-muted-foreground">
            Reuse your own PowerPoint visual language.
          </p>
        </div>
        <UploadFileButton />
      </div>
      {catalog.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Upload a PowerPoint once to make it available here.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.map((item) => {
            return (
              <CustomTemplateCard
                key={item.template.id}
                item={item}
                selected={selectedTemplateId === item.template.id}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      )}
      <UploadTemplateDialog />
      <EditTemplateDialog />
      <DeleteTemplateDialog />
    </section>
  );
}
