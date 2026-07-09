import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconArchive,
  IconFileText,
  IconHistory,
  IconLoader2,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import type {
  MemoryDocumentListResponse,
  MemoryKind,
  MemoryLifecycleMemory,
} from "@vm0/api-contracts/contracts/zero-memory";
import { Button, Input, cn } from "@vm0/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";

import {
  createMemoryLifecycleMemory$,
  forgetLifecycleDocument$,
  forgetLifecycleMemory$,
  forgetMemoryByPrompt$,
  memoryCreateEntity$,
  memoryCreateKind$,
  memoryCreateText$,
  memoryDocumentProviderFilter$,
  memoryDocumentStatusFilter$,
  memoryDocuments$,
  memoryForgetPrompt$,
  memoryForgetTarget$,
  memoryForgotten$,
  memoryLifecycleKindFilter$,
  memoryLifecycleList$,
  memoryLifecycleStatusFilter$,
  memoryProfiles$,
  selectedMemoryHistory$,
  selectedMemoryHistoryTarget$,
  setMemoryCreateEntity$,
  setMemoryCreateKind$,
  setMemoryCreateText$,
  setMemoryDocumentProviderFilter$,
  setMemoryDocumentStatusFilter$,
  setMemoryForgetPrompt$,
  setMemoryForgetTarget$,
  setMemoryLifecycleKindFilter$,
  setMemoryLifecycleStatusFilter$,
  setSelectedMemoryHistoryTarget$,
  updateLifecycleMemory$,
  type MemoryDocumentStatusFilter,
  type MemoryKindFilter,
  type MemoryLifecycleStatusFilter,
  type MemorySourceProviderFilter,
} from "../../signals/memory-page/memory-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

type MemoryDocumentRow = MemoryDocumentListResponse["documents"][number];

const MEMORY_KIND_OPTIONS: readonly {
  readonly value: MemoryKind;
  readonly label: string;
}[] = [
  { value: "key_fact", label: "Key fact" },
  { value: "preference", label: "Preference" },
  { value: "open_loop", label: "Open loop" },
  { value: "role", label: "Role" },
  { value: "project", label: "Project" },
  { value: "communication_style", label: "Communication style" },
  { value: "recent_context", label: "Recent context" },
];

const MEMORY_KIND_FILTER_OPTIONS: readonly {
  readonly value: MemoryKindFilter;
  readonly label: string;
}[] = [{ value: "all", label: "All kinds" }, ...MEMORY_KIND_OPTIONS];

const MEMORY_STATUS_OPTIONS: readonly {
  readonly value: MemoryLifecycleStatusFilter;
  readonly label: string;
}[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

const DOCUMENT_STATUS_OPTIONS: readonly {
  readonly value: MemoryDocumentStatusFilter;
  readonly label: string;
}[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "deleted", label: "Deleted" },
];

const PROVIDER_OPTIONS: readonly {
  readonly value: MemorySourceProviderFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All sources" },
  { value: "github", label: "GitHub" },
  { value: "notion", label: "Notion" },
  { value: "slack", label: "Slack" },
  { value: "gmail", label: "Gmail" },
];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function SectionHeader({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) {
  return (
    <header className="border-b border-border/70 px-4 py-3">
      <h2 className="text-sm font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
    </header>
  );
}

function CreateMemoryPanel() {
  const text = useGet(memoryCreateText$);
  const kind = useGet(memoryCreateKind$);
  const entity = useGet(memoryCreateEntity$);
  const setText = useSet(setMemoryCreateText$);
  const setKind = useSet(setMemoryCreateKind$);
  const setEntity = useSet(setMemoryCreateEntity$);
  const [createLoadable, createMemory] = useLoadableSet(
    createMemoryLifecycleMemory$,
  );
  const pageSignal = useGet(pageSignal$);
  const creating = createLoadable.state === "loading";

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <SectionHeader
        title="Create memory"
        description="Add an explicit memory without waiting for connector extraction."
      />
      <form
        className="grid gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          detach(createMemory(pageSignal), Reason.DomCallback);
        }}
      >
        <textarea
          value={text}
          rows={3}
          placeholder="Remember that..."
          className="min-h-24 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 text-foreground placeholder:text-muted-foreground"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <div className="grid gap-2 sm:grid-cols-[160px_1fr_auto]">
          <Select
            value={kind}
            onValueChange={(value) => {
              setKind(value as MemoryKind);
            }}
          >
            <SelectTrigger className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEMORY_KIND_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Input
            value={entity}
            placeholder="Entity or scope label"
            className="h-9 text-sm"
            onChange={(event) => {
              setEntity(event.target.value);
            }}
          />
          <Button
            type="submit"
            size="sm"
            className="h-9 gap-1.5 px-3 text-sm"
            disabled={creating || text.trim().length === 0}
          >
            {creating ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              <IconPlus className="h-4 w-4" />
            )}
            <span>{creating ? "Creating" : "Create"}</span>
          </Button>
        </div>
      </form>
    </section>
  );
}

function ForgetPromptPanel() {
  const prompt = useGet(memoryForgetPrompt$);
  const target = useGet(memoryForgetTarget$);
  const setPrompt = useSet(setMemoryForgetPrompt$);
  const setTarget = useSet(setMemoryForgetTarget$);
  const [forgetLoadable, forgetByPrompt] = useLoadableSet(
    forgetMemoryByPrompt$,
  );
  const pageSignal = useGet(pageSignal$);
  const forgetting = forgetLoadable.state === "loading";

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <SectionHeader
        title="Forget by prompt"
        description="Remove matching active memories or document evidence and record tombstones."
      />
      <form
        className="grid gap-3 p-4 sm:grid-cols-[1fr_150px_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          detach(forgetByPrompt(pageSignal), Reason.DomCallback);
        }}
      >
        <Input
          value={prompt}
          placeholder="Forget anything about..."
          className="h-9 text-sm"
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
        <Select
          value={target}
          onValueChange={(value) => {
            setTarget(value as "all" | "memories" | "documents");
          }}
        >
          <SelectTrigger className="h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="memories">Memories</SelectItem>
            <SelectItem value="documents">Documents</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="submit"
          size="sm"
          variant="destructive"
          className="h-9 gap-1.5 px-3 text-sm"
          disabled={forgetting || prompt.trim().length === 0}
        >
          {forgetting ? (
            <IconLoader2 className="h-4 w-4 animate-spin" />
          ) : (
            <IconTrash className="h-4 w-4" />
          )}
          <span>{forgetting ? "Forgetting" : "Forget"}</span>
        </Button>
      </form>
    </section>
  );
}

function MemoryCard({ memory }: { readonly memory: MemoryLifecycleMemory }) {
  const [updateLoadable, updateMemory] = useLoadableSet(updateLifecycleMemory$);
  const [forgetLoadable, forgetMemory] = useLoadableSet(forgetLifecycleMemory$);
  const setHistoryTarget = useSet(setSelectedMemoryHistoryTarget$);
  const pageSignal = useGet(pageSignal$);
  const updating = updateLoadable.state === "loading";
  const forgetting = forgetLoadable.state === "loading";

  return (
    <article className="rounded-lg border border-border/70 bg-background p-3">
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const text = String(form.get("text") ?? "").trim();
          if (text.length === 0 || text === memory.text) {
            return;
          }
          detach(
            updateMemory(memory, { text }, pageSignal),
            Reason.DomCallback,
          );
        }}
      >
        <textarea
          name="text"
          defaultValue={memory.text}
          rows={2}
          className="min-h-16 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 text-foreground"
        />
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-xs leading-5 text-muted-foreground">
            {memory.kind} - {memory.entity.displayName ?? "No entity"} -{" "}
            {memory.contextSpace?.displayName ?? "No context"} -{" "}
            {formatDate(memory.updatedAt)}
          </p>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              onClick={() => {
                setHistoryTarget({
                  targetKind: "memory",
                  targetId: memory.id,
                });
              }}
            >
              <IconHistory className="h-3.5 w-3.5" />
              <span>History</span>
            </Button>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              disabled={updating}
            >
              {updating ? (
                <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <IconArchive className="h-3.5 w-3.5" />
              )}
              <span>{updating ? "Saving" : "Save version"}</span>
            </Button>
            {memory.status === "active" ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-xs"
                disabled={forgetting}
                onClick={() => {
                  detach(forgetMemory(memory, pageSignal), Reason.DomCallback);
                }}
              >
                {forgetting ? (
                  <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <IconTrash className="h-3.5 w-3.5" />
                )}
                <span>{forgetting ? "Forgetting" : "Forget"}</span>
              </Button>
            ) : null}
          </div>
        </div>
      </form>
    </article>
  );
}

function MemoryListPanel() {
  const loadable = useLoadable(memoryLifecycleList$);
  const status = useGet(memoryLifecycleStatusFilter$);
  const kind = useGet(memoryLifecycleKindFilter$);
  const setStatus = useSet(setMemoryLifecycleStatusFilter$);
  const setKind = useSet(setMemoryLifecycleKindFilter$);

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Memories
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Edit active memories and inspect their version history.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as MemoryLifecycleStatusFilter);
            }}
          >
            <SelectTrigger className="h-9 w-[116px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEMORY_STATUS_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select
            value={kind}
            onValueChange={(value) => {
              setKind(value as MemoryKindFilter);
            }}
          >
            <SelectTrigger className="h-9 w-[170px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEMORY_KIND_FILTER_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      </div>
      {loadable.state === "loading" ? (
        <PanelLoading label="Loading memories" />
      ) : loadable.state === "hasError" ? (
        <PanelEmpty label="Memories are unavailable" />
      ) : loadable.data.memories.length === 0 ? (
        <PanelEmpty label="No memories found" />
      ) : (
        <div className="grid gap-2 p-3">
          {loadable.data.memories.map((memory) => {
            return <MemoryCard key={memory.id} memory={memory} />;
          })}
        </div>
      )}
    </section>
  );
}

function DocumentRow({
  document,
  forgetDocument,
  forgetting,
}: {
  readonly document: MemoryDocumentRow;
  readonly forgetDocument: (
    documentId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly forgetting: boolean;
}) {
  const setHistoryTarget = useSet(setSelectedMemoryHistoryTarget$);
  const pageSignal = useGet(pageSignal$);

  return (
    <article className="flex min-w-0 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {document.title ?? document.externalId}
        </p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {document.provider}:{document.externalId} - {document.chunkCount}{" "}
          chunks - {document.contextSpace.displayName}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          onClick={() => {
            setHistoryTarget({
              targetKind: "document",
              targetId: document.id,
            });
          }}
        >
          <IconHistory className="h-3.5 w-3.5" />
          <span>History</span>
        </Button>
        {document.status === "active" ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            disabled={forgetting}
            onClick={() => {
              detach(
                forgetDocument(document.id, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {forgetting ? (
              <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <IconTrash className="h-3.5 w-3.5" />
            )}
            <span>{forgetting ? "Forgetting" : "Forget"}</span>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function DocumentsPanel() {
  const loadable = useLoadable(memoryDocuments$);
  const status = useGet(memoryDocumentStatusFilter$);
  const provider = useGet(memoryDocumentProviderFilter$);
  const setStatus = useSet(setMemoryDocumentStatusFilter$);
  const setProvider = useSet(setMemoryDocumentProviderFilter$);
  const [forgetLoadable, forgetDocument] = useLoadableSet(
    forgetLifecycleDocument$,
  );
  const forgetting = forgetLoadable.state === "loading";

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Documents
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Raw connector evidence indexed for document RAG.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as MemoryDocumentStatusFilter);
            }}
          >
            <SelectTrigger className="h-9 w-[116px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOCUMENT_STATUS_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Select
            value={provider}
            onValueChange={(value) => {
              setProvider(value as MemorySourceProviderFilter);
            }}
          >
            <SelectTrigger className="h-9 w-[132px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_OPTIONS.map((option) => {
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      </div>
      {loadable.state === "loading" ? (
        <PanelLoading label="Loading documents" />
      ) : loadable.state === "hasError" ? (
        <PanelEmpty label="Documents are unavailable" />
      ) : loadable.data.documents.length === 0 ? (
        <PanelEmpty label="No documents found" />
      ) : (
        <div className="divide-y divide-border/70">
          {loadable.data.documents.map((document) => {
            return (
              <DocumentRow
                key={document.id}
                document={document}
                forgetDocument={forgetDocument}
                forgetting={forgetting}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProfilesAndForgottenPanel() {
  const profilesLoadable = useLoadable(memoryProfiles$);
  const forgottenLoadable = useLoadable(memoryForgotten$);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="zero-card min-w-0 overflow-hidden">
        <SectionHeader
          title="Profiles"
          description="Derived profile sections built from memories."
        />
        {profilesLoadable.state === "loading" ? (
          <PanelLoading label="Loading profiles" />
        ) : profilesLoadable.state === "hasError" ? (
          <PanelEmpty label="Profiles are unavailable" />
        ) : profilesLoadable.data.profiles.length === 0 ? (
          <PanelEmpty label="No profiles found" />
        ) : (
          <div className="divide-y divide-border/70">
            {profilesLoadable.data.profiles.map((profile) => {
              return (
                <article key={profile.id} className="px-4 py-3">
                  <p className="text-sm font-medium text-foreground">
                    {profile.section}
                  </p>
                  <p className="mt-1 line-clamp-3 text-sm leading-6 text-muted-foreground">
                    {profile.content}
                  </p>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <section className="zero-card min-w-0 overflow-hidden">
        <SectionHeader
          title="Forgotten"
          description="Tombstones that block forgotten content from returning."
        />
        {forgottenLoadable.state === "loading" ? (
          <PanelLoading label="Loading tombstones" />
        ) : forgottenLoadable.state === "hasError" ? (
          <PanelEmpty label="Tombstones are unavailable" />
        ) : forgottenLoadable.data.forgotten.length === 0 ? (
          <PanelEmpty label="No tombstones found" />
        ) : (
          <div className="divide-y divide-border/70">
            {forgottenLoadable.data.forgotten.map((tombstone) => {
              return (
                <article key={tombstone.id} className="px-4 py-3">
                  <p className="text-sm font-medium text-foreground">
                    {tombstone.targetTitle ??
                      tombstone.targetText ??
                      tombstone.fingerprint}
                  </p>
                  <p className="mt-1 break-all text-xs leading-5 text-muted-foreground">
                    {tombstone.targetKind} - {tombstone.fingerprint}
                  </p>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryPanel() {
  const target = useGet(selectedMemoryHistoryTarget$);
  const loadable = useLoadable(selectedMemoryHistory$);
  const setTarget = useSet(setSelectedMemoryHistoryTarget$);

  return (
    <section
      className={cn(
        "zero-card min-w-0 overflow-hidden",
        target ? "" : "hidden",
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            History
          </h2>
          <p className="mt-0.5 break-all text-sm text-muted-foreground">
            {target ? `${target.targetKind}:${target.targetId}` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2.5 text-xs"
          onClick={() => {
            setTarget(null);
          }}
        >
          Close
        </Button>
      </div>
      {loadable.state === "loading" ? (
        <PanelLoading label="Loading history" />
      ) : loadable.state === "hasError" ? (
        <PanelEmpty label="History is unavailable" />
      ) : !loadable.data || loadable.data.history.length === 0 ? (
        <PanelEmpty label="No history found" />
      ) : (
        <div className="divide-y divide-border/70">
          {loadable.data.history.map((version) => {
            return (
              <article key={version.id} className="px-4 py-3">
                <p className="text-sm font-medium text-foreground">
                  v{version.version} {version.operation ?? "change"}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {formatDate(version.createdAt)} - {version.contentHash}
                </p>
                {(version.text ?? version.title) ? (
                  <p className="mt-1 text-sm leading-6 text-foreground">
                    {version.text ?? version.title}
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PanelLoading({ label }: { readonly label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
      <IconLoader2 className="h-4 w-4 animate-spin" />
      <span>{label}</span>
    </div>
  );
}

function PanelEmpty({ label }: { readonly label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center px-6 text-center text-sm text-muted-foreground">
      <div className="flex flex-col items-center gap-2">
        <IconFileText className="h-5 w-5" />
        <span>{label}</span>
      </div>
    </div>
  );
}

export function MemoryLifecycle() {
  return (
    <div className="grid gap-4">
      <CreateMemoryPanel />
      <ForgetPromptPanel />
      <MemoryListPanel />
      <DocumentsPanel />
      <HistoryPanel />
      <ProfilesAndForgottenPanel />
    </div>
  );
}
