import {
  presentationTemplatesContract,
  type PresentationTemplate,
  type PresentationTemplateRevision,
} from "@vm0/api-contracts/contracts/presentation-templates";
import { toast } from "@vm0/ui/components/ui/sonner";
import { command, computed, state } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { onRef, setLoop } from "../utils.ts";

const reload$ = state(0);
const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export interface PresentationTemplateCatalogItem {
  readonly template: PresentationTemplate;
  readonly previewUrl: string | null;
  readonly revisions: readonly PresentationTemplateRevision[];
}

export interface PresentationTemplateUploadDraft {
  readonly file: File;
  readonly mode: "create" | "replace";
  readonly templateId?: string;
  readonly name: string;
  readonly description: string;
  readonly rightsConfirmed: boolean;
}

export interface PresentationTemplateEditDraft {
  readonly templateId: string;
  readonly name: string;
  readonly description: string;
}

export interface PresentationTemplateDeleteTarget {
  readonly templateId: string;
  readonly name: string;
}

const internalUploadDraft$ = state<PresentationTemplateUploadDraft | null>(
  null,
);
const internalEditDraft$ = state<PresentationTemplateEditDraft | null>(null);
const internalDeleteTarget$ = state<PresentationTemplateDeleteTarget | null>(
  null,
);

export const presentationTemplateUploadDraft$ = computed((get) => {
  return get(internalUploadDraft$);
});

export const presentationTemplateEditDraft$ = computed((get) => {
  return get(internalEditDraft$);
});

export const presentationTemplateDeleteTarget$ = computed((get) => {
  return get(internalDeleteTarget$);
});

export const setPresentationTemplateUploadDraft$ = command(
  ({ set }, value: PresentationTemplateUploadDraft | null) => {
    set(internalUploadDraft$, value);
  },
);

export const setPresentationTemplateEditDraft$ = command(
  ({ set }, value: PresentationTemplateEditDraft | null) => {
    set(internalEditDraft$, value);
  },
);

export const setPresentationTemplateDeleteTarget$ = command(
  ({ set }, value: PresentationTemplateDeleteTarget | null) => {
    set(internalDeleteTarget$, value);
  },
);

export const presentationTemplateCatalog$ = computed(
  async (get): Promise<readonly PresentationTemplateCatalogItem[]> => {
    get(reload$);
    const client = get(zeroClient$)(presentationTemplatesContract);
    const result = await accept(
      client.list({ query: { includeArchived: true } }),
      [200],
    );
    return await Promise.all(
      result.body.templates.map(async (template) => {
        const loadPreview = async () => {
          if (!template.activeRevision) {
            return null;
          }
          const response = await accept(
            client.preview({
              params: {
                id: template.id,
                revisionId: template.activeRevision.id,
                index: 0,
              },
            }),
            [200],
          );
          return response.body.url;
        };
        const loadRevisions = async () => {
          if (!template.canManage) {
            return [];
          }
          const response = await accept(
            client.listRevisions({ params: { id: template.id } }),
            [200],
          );
          return response.body.revisions;
        };
        const [preview, revisions] = await Promise.all([
          loadPreview(),
          loadRevisions(),
        ]);
        return { template, previewUrl: preview, revisions };
      }),
    );
  },
);

export const refreshPresentationTemplates$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

function hasActiveImport(
  catalog: readonly PresentationTemplateCatalogItem[],
): boolean {
  return catalog.some((item) => {
    const status = item.template.latestImport?.status;
    return (
      status === "uploading" || status === "queued" || status === "processing"
    );
  });
}

const watchPresentationTemplates$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    await setLoop(
      async (loopSignal) => {
        set(refreshPresentationTemplates$);
        const catalog = await get(presentationTemplateCatalog$);
        loopSignal.throwIfAborted();
        return !hasActiveImport(catalog);
      },
      3000,
      signal,
    );
    signal.throwIfAborted();
  },
);

export const presentationTemplatePollingRef$ = onRef(
  command(async ({ set }, _element: HTMLElement, signal: AbortSignal) => {
    await set(watchPresentationTemplates$, signal);
    signal.throwIfAborted();
  }),
);

export const presentationTemplateCatalogRef$ = onRef(
  command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(refreshPresentationTemplates$);
  }),
);

async function putFile(
  uploadUrl: string,
  file: File,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || PPTX_CONTENT_TYPE },
    body: file,
    signal,
  });
  if (!response.ok) {
    throw new Error(`PowerPoint upload failed with HTTP ${response.status}`);
  }
}

async function uploadImport(
  createClient: ZeroClientFactory,
  args: {
    readonly templateId: string;
    readonly file: File;
  },
  signal: AbortSignal,
): Promise<void> {
  const client = createClient(presentationTemplatesContract);
  const prepared = await accept(
    client.prepareImport({
      params: { id: args.templateId },
      body: {
        filename: args.file.name,
        contentType: args.file.type || PPTX_CONTENT_TYPE,
        size: args.file.size,
        confirmsRights: true,
      },
      fetchOptions: { signal },
    }),
    [200],
  );
  signal.throwIfAborted();
  await putFile(prepared.body.uploadUrl, args.file, signal);
  signal.throwIfAborted();
  await accept(
    client.commitImport({
      params: {
        id: args.templateId,
        importId: prepared.body.import.id,
      },
      body: {},
      fetchOptions: { signal },
    }),
    [202],
  );
}

export const createPresentationTemplate$ = command(
  async (
    { get, set },
    args: {
      readonly name: string;
      readonly description?: string;
      readonly file: File;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const createClient = get(zeroClient$);
    const client = createClient(presentationTemplatesContract);
    const created = await accept(
      client.create({
        body: {
          name: args.name,
          description: args.description ?? null,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    await uploadImport(
      createClient,
      { templateId: created.body.id, file: args.file },
      signal,
    );
    set(refreshPresentationTemplates$);
    toast.success("PowerPoint uploaded. vm0 is analyzing your template.");
  },
);

export const replacePresentationTemplateSource$ = command(
  async (
    { get, set },
    args: { readonly templateId: string; readonly file: File },
    signal: AbortSignal,
  ): Promise<void> => {
    const createClient = get(zeroClient$);
    await uploadImport(createClient, args, signal);
    signal.throwIfAborted();
    set(refreshPresentationTemplates$);
    toast.success("New PowerPoint uploaded. The active version is unchanged.");
  },
);

export const updatePresentationTemplate$ = command(
  async (
    { get, set },
    args: {
      readonly templateId: string;
      readonly name?: string;
      readonly description?: string | null;
      readonly accessScope?: "private" | "organization";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(presentationTemplatesContract);
    await accept(
      client.update({
        params: { id: args.templateId },
        body: {
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined
            ? { description: args.description }
            : {}),
          ...(args.accessScope !== undefined
            ? { accessScope: args.accessScope }
            : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(refreshPresentationTemplates$);
  },
);

export const archivePresentationTemplate$ = command(
  async (
    { get, set },
    args: { readonly templateId: string; readonly archived: boolean },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(presentationTemplatesContract);
    await accept(
      client.archive({
        params: { id: args.templateId },
        body: { archived: args.archived },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(refreshPresentationTemplates$);
  },
);

export const deletePresentationTemplate$ = command(
  async (
    { get, set },
    templateId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(presentationTemplatesContract);
    await accept(
      client.delete({
        params: { id: templateId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(refreshPresentationTemplates$);
    toast.success("Presentation template deleted");
  },
);

export const retryPresentationTemplateImport$ = command(
  async (
    { get, set },
    args: { readonly templateId: string; readonly importId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(presentationTemplatesContract);
    await accept(
      client.retryImport({
        params: { id: args.templateId, importId: args.importId },
        body: {},
        fetchOptions: { signal },
      }),
      [202],
    );
    signal.throwIfAborted();
    set(refreshPresentationTemplates$);
  },
);

export const activatePresentationTemplateRevision$ = command(
  async (
    { get, set },
    args: { readonly templateId: string; readonly revisionId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(presentationTemplatesContract);
    await accept(
      client.activateRevision({
        params: { id: args.templateId, revisionId: args.revisionId },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(refreshPresentationTemplates$);
    toast.success("Template version activated");
  },
);
