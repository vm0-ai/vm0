import { screen, waitFor } from "@testing-library/react";
import {
  imageReferencesContract,
  type CreateImageReferenceBody,
  type ImageReference,
  type ImageReferencePreviewUrl,
  type UpdateImageReferenceBody,
} from "@okouai/api-contracts/contracts/image-references";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { setMockOrgMembers } from "../../../mocks/handlers/api-org-members.ts";
import { agentChatComposerSignals$ } from "../../../signals/okou-page/agent-composer-signals.ts";
import type { ImageReferenceLibrarySignals } from "../../../signals/okou-page/image-reference-library.ts";
import { mockNow, now } from "../../../lib/time.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

const USER_ID = "test-user-123";
const ORG_ID = "org_default";
const OTHER_USER_ID = "test-user-456";
const REFERENCE_TOPIC = "imageReferencesChanged";

function referenceId(index: number): string {
  return `10000000-0000-4000-a000-${index.toString().padStart(12, "0")}`;
}

function sourceFileId(index: number): string {
  return `20000000-0000-4000-a000-${index.toString().padStart(12, "0")}`;
}

function createReference(options: {
  readonly index: number;
  readonly title: string;
  readonly ownerUserId?: string;
  readonly visibility?: "private" | "public";
  readonly canManage?: boolean;
  readonly canModerate?: boolean;
  readonly previewUrl?: string;
  readonly expiresAt?: string;
  readonly updatedAt?: string;
}): ImageReference {
  const id = referenceId(options.index);
  const ownerUserId = options.ownerUserId ?? USER_ID;
  return {
    id,
    title: options.title,
    visibility: options.visibility ?? "private",
    ownerUserId,
    creator: {
      userId: ownerUserId,
      displayName: null,
      imageUrl: null,
    },
    sourceFilename: `${options.title}.png`,
    contentType: "image/png",
    width: 1280,
    height: 720,
    previewUrl:
      options.previewUrl ??
      `https://preview.example.test/references/${id}/initial.png`,
    previewUrlExpiresAt:
      options.expiresAt ?? new Date(now() + 15 * 60 * 1000).toISOString(),
    canManage: options.canManage ?? ownerUserId === USER_ID,
    canModerate: options.canModerate ?? false,
    createdAt: "2026-09-08T12:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-09-08T12:00:00.000Z",
  };
}

interface ImageReferenceLibraryControl {
  readonly requests: {
    readonly creates: CreateImageReferenceBody[];
    readonly updates: {
      readonly referenceId: string;
      readonly body: UpdateImageReferenceBody;
    }[];
    readonly deletes: string[];
    readonly previewResolutions: string[][];
    readonly listCount: number;
  };
  readonly subscriptionsWereReady: () => boolean;
  deferNextList(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  };
  replace(references: readonly ImageReference[]): void;
  renew(preview: ImageReferencePreviewUrl): void;
  moderateNextUpdate(): void;
}

function installImageReferenceLibrary(
  initialReferences: readonly ImageReference[],
): ImageReferenceLibraryControl {
  let references = [...initialReferences];
  let listCount = 0;
  let subscriptionsWereReady = false;
  let nextCreateIndex = 900;
  let moderateNextUpdate = false;
  const creates: CreateImageReferenceBody[] = [];
  const updates: ImageReferenceLibraryControl["requests"]["updates"] = [];
  const deletes: string[] = [];
  const previewResolutions: string[][] = [];
  const renewedPreviews = new Map<string, ImageReferencePreviewUrl>();
  let nextListGate: {
    readonly started: ReturnType<typeof context.mocks.deferred<void>>;
    readonly release: ReturnType<typeof context.mocks.deferred<void>>;
  } | null = null;

  context.mocks.api(imageReferencesContract.list, async ({ respond }) => {
    listCount += 1;
    subscriptionsWereReady ||=
      context.mocks.ably.hasSubscriptionOnChannel(
        `user:${USER_ID}`,
        REFERENCE_TOPIC,
      ) &&
      context.mocks.ably.hasSubscriptionOnChannel(
        `org:${ORG_ID}`,
        REFERENCE_TOPIC,
      );
    const snapshot = [...references];
    const gate = nextListGate;
    nextListGate = null;
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    return respond(200, snapshot);
  });
  context.mocks.api(
    imageReferencesContract.resolvePreviewUrls,
    ({ body, respond }) => {
      previewResolutions.push([...body.referenceIds]);
      const previews = body.referenceIds.flatMap((referenceId) => {
        const renewed = renewedPreviews.get(referenceId);
        if (renewed) {
          return [renewed];
        }
        const reference = references.find((candidate) => {
          return candidate.id === referenceId;
        });
        return reference
          ? [
              {
                referenceId,
                url: reference.previewUrl,
                expiresAt: reference.previewUrlExpiresAt,
              },
            ]
          : [];
      });
      return respond(200, { previews });
    },
  );
  context.mocks.api(imageReferencesContract.create, ({ body, respond }) => {
    creates.push(body);
    nextCreateIndex += 1;
    const created = createReference({
      index: nextCreateIndex,
      title: body.title,
      visibility: body.visibility,
    });
    references = [created, ...references];
    return respond(201, created);
  });
  context.mocks.api(
    imageReferencesContract.update,
    ({ params, body, respond }) => {
      updates.push({ referenceId: params.referenceId, body });
      const previous = references.find((candidate) => {
        return candidate.id === params.referenceId;
      });
      if (!previous) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Image reference not found" },
        });
      }
      if (moderateNextUpdate) {
        moderateNextUpdate = false;
        references = references.filter((candidate) => {
          return candidate.id !== params.referenceId;
        });
        return respond(204);
      }
      const updated = {
        ...previous,
        ...body,
        updatedAt: "2026-09-08T12:01:00.000Z",
      };
      references = references.map((candidate) => {
        return candidate.id === updated.id ? updated : candidate;
      });
      return respond(200, updated);
    },
  );
  context.mocks.api(imageReferencesContract.delete, ({ params, respond }) => {
    deletes.push(params.referenceId);
    references = references.filter((candidate) => {
      return candidate.id !== params.referenceId;
    });
    return respond(204);
  });

  return {
    requests: {
      creates,
      updates,
      deletes,
      previewResolutions,
      get listCount() {
        return listCount;
      },
    },
    subscriptionsWereReady: () => {
      return subscriptionsWereReady;
    },
    deferNextList() {
      const started = context.mocks.deferred<void>();
      const release = context.mocks.deferred<void>();
      nextListGate = { started, release };
      return {
        started: started.promise,
        release: () => {
          release.resolve();
        },
      };
    },
    replace(nextReferences) {
      references = [...nextReferences];
    },
    renew(preview) {
      renewedPreviews.set(preview.referenceId, preview);
    },
    moderateNextUpdate() {
      moderateNextUpdate = true;
    },
  };
}

function imageReferenceLibrary(): ImageReferenceLibrarySignals {
  return context.store.get(agentChatComposerSignals$).template.imageReference;
}

async function setupImageReferencePage(
  references: readonly ImageReference[],
): Promise<{
  readonly chat: ReturnType<typeof mockTemplateChat>;
  readonly control: ImageReferenceLibraryControl;
  readonly library: ImageReferenceLibrarySignals;
}> {
  const chat = mockTemplateChat();
  const control = installImageReferenceLibrary(references);
  setMockOrgMembers({
    members: [
      {
        userId: USER_ID,
        email: "owner@example.test",
        firstName: "Olivia",
        lastName: "Owner",
        imageUrl: "https://images.example.test/owner.png",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        userId: OTHER_USER_ID,
        email: "creator@example.test",
        firstName: "Casey",
        lastName: "Creator",
        imageUrl: "https://images.example.test/creator.png",
        role: "member",
        joinedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ReferenceImages]: true },
  });
  return { chat, control, library: imageReferenceLibrary() };
}

async function waitForTitles(
  signal: ImageReferenceLibrarySignals["references$"],
  expected: readonly string[],
): Promise<void> {
  await waitFor(async () => {
    expect(
      (await context.store.get(signal)).map((reference) => {
        return reference.title;
      }),
    ).toStrictEqual(expected);
  });
}

function triggerReferenceEvent(scope: "user" | "org"): void {
  context.mocks.ably.triggerOnChannel(
    `${scope}:${scope === "user" ? USER_ID : ORG_ID}`,
    REFERENCE_TOPIC,
    {},
  );
}

test("load owner and organization catalogs only after both realtime subscriptions", async () => {
  const own = createReference({ index: 1, title: "My watercolor" });
  const shared = createReference({
    index: 2,
    title: "Studio collage",
    ownerUserId: OTHER_USER_ID,
    visibility: "public",
  });
  const { control, library } = await setupImageReferencePage([own, shared]);

  const ownReferences = await context.store.get(library.ownReferences$);
  expect(
    ownReferences.map(({ title }) => {
      return title;
    }),
  ).toStrictEqual(["My watercolor"]);
  const organizationReferences = await context.store.get(
    library.organizationReferences$,
  );
  expect(
    organizationReferences.map(({ title }) => {
      return title;
    }),
  ).toStrictEqual(["Studio collage"]);
  const pickerItems = await context.store.get(library.pickerItems$);
  expect(
    pickerItems.map(({ reference }) => {
      return reference.title;
    }),
  ).toStrictEqual(["My watercolor", "Studio collage"]);
  expect(pickerItems[1]?.creator).toMatchObject({
    userId: OTHER_USER_ID,
    displayName: "Casey Creator",
  });
  expect(control.requests.listCount).toBeGreaterThan(0);
  expect(control.subscriptionsWereReady()).toBeTruthy();
});

test("catch an invalidation that arrives during the baseline request", async () => {
  mockTemplateChat();
  const baseline = createReference({ index: 10, title: "Baseline" });
  const added = createReference({ index: 11, title: "Arrived during fetch" });
  const control = installImageReferenceLibrary([baseline]);
  const gate = control.deferNextList();
  const page = setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ReferenceImages]: true },
  });

  await gate.started;
  control.replace([added, baseline]);
  triggerReferenceEvent("user");
  gate.release();
  await page;
  const library = imageReferenceLibrary();
  await waitForTitles(library.ownReferences$, [
    "Arrived during fetch",
    "Baseline",
  ]);
  expect(control.requests.listCount).toBeGreaterThanOrEqual(2);
});

test("keep the disabled switch on the existing no-library path", async () => {
  mockTemplateChat();
  const control = installImageReferenceLibrary([
    createReference({ index: 3, title: "Hidden" }),
  ]);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.ReferenceImages]: false },
  });

  const library = imageReferenceLibrary();
  expect(context.store.get(library.enabled$)).toBeFalsy();
  await expect(context.store.get(library.references$)).resolves.toStrictEqual(
    [],
  );
  expect(control.requests.listCount).toBe(0);
  expect(
    context.mocks.ably.hasSubscriptionOnChannel(
      `user:${USER_ID}`,
      REFERENCE_TOPIC,
    ),
  ).toBeFalsy();
});

test("create, rename, share, moderate, and delete through API boundaries", async () => {
  const owned = createReference({ index: 4, title: "Owned" });
  const shared = createReference({
    index: 5,
    title: "Shared",
    ownerUserId: OTHER_USER_ID,
    visibility: "public",
    canManage: false,
    canModerate: true,
  });
  const { control, library } = await setupImageReferencePage([owned, shared]);

  const created = await context.store.set(
    library.create$,
    {
      sourceFileId: sourceFileId(1),
      title: "New reference",
      visibility: "private",
    },
    context.signal,
  );
  await context.store.set(
    library.rename$,
    created.id,
    "Renamed reference",
    context.signal,
  );
  await context.store.set(
    library.setVisibility$,
    created.id,
    "public",
    context.signal,
  );
  control.moderateNextUpdate();
  await context.store.set(library.adminUnshare$, shared.id, context.signal);
  await context.store.set(library.delete$, owned.id, context.signal);

  await waitForTitles(library.ownReferences$, ["Renamed reference"]);
  await expect(
    context.store.get(library.organizationReferences$),
  ).resolves.toStrictEqual([]);
  expect(control.requests.creates).toStrictEqual([
    {
      sourceFileId: sourceFileId(1),
      title: "New reference",
      visibility: "private",
    },
  ]);
  expect(control.requests.updates).toStrictEqual([
    { referenceId: created.id, body: { title: "Renamed reference" } },
    { referenceId: created.id, body: { visibility: "public" } },
    { referenceId: shared.id, body: { visibility: "private" } },
  ]);
  expect(control.requests.deletes).toStrictEqual([owned.id]);
  await expect(
    context.store.get(library.resolve(shared.id)),
  ).resolves.toBeNull();
});

test("renew preview URLs by reference identity while retaining the loaded image", async () => {
  mockNow(new Date("2026-09-08T15:50:00.000Z"), context.signal);
  const initial = createReference({
    index: 6,
    title: "Buffered preview",
    previewUrl: "https://preview.example.test/old.png",
    expiresAt: "2026-09-08T16:00:00.000Z",
  });
  const { control, library } = await setupImageReferencePage([initial]);
  const [item] = await context.store.get(library.pickerItems$);
  if (!item) {
    throw new Error("Expected an image reference picker item");
  }
  const loaded = {
    desiredUrl: initial.previewUrl,
    sourceUrl: initial.previewUrl,
    slot: "a" as const,
  };
  await context.store.set(
    item.imageBuffers.card.commitLoadedImage$,
    loaded,
    context.signal,
  );

  const renewed = {
    referenceId: initial.id,
    url: "https://preview.example.test/renewed.png",
    expiresAt: "2026-09-08T16:15:00.000Z",
  };
  control.renew(renewed);
  mockNow(new Date("2026-09-08T15:59:30.000Z"), context.signal);
  await context.store.set(
    library.refreshPreviewUrlsIfExpiring$,
    context.signal,
  );

  await expect(
    context.store.get(item.imageBuffers.card.desiredUrl$),
  ).resolves.toBe(renewed.url);
  expect(context.store.get(item.imageBuffers.card.state$).active).toStrictEqual(
    loaded,
  );
  expect(control.requests.previewResolutions).toStrictEqual([[initial.id]]);
  const refreshedItem = (await context.store.get(library.pickerItems$))[0];
  expect(refreshedItem?.imageBuffers).toBe(item.imageBuffers);
});

test("apply user and organization invalidations and evict inaccessible state", async () => {
  const own = createReference({ index: 7, title: "Owned baseline" });
  const shared = createReference({
    index: 8,
    title: "Organization baseline",
    ownerUserId: OTHER_USER_ID,
    visibility: "public",
  });
  const { control, library } = await setupImageReferencePage([own, shared]);
  const sharedResolution$ = library.resolve(shared.id);
  await expect(context.store.get(sharedResolution$)).resolves.toMatchObject({
    id: shared.id,
  });
  const ownPickerItem = (await context.store.get(library.pickerItems$))[0];
  if (!ownPickerItem) {
    throw new Error("Expected an owner picker item");
  }
  const loaded = {
    desiredUrl: own.previewUrl,
    sourceUrl: own.previewUrl,
    slot: "a" as const,
  };
  await context.store.set(
    ownPickerItem.imageBuffers.card.commitLoadedImage$,
    loaded,
    context.signal,
  );

  const added = createReference({ index: 9, title: "Second owned" });
  control.replace([added, own, shared]);
  triggerReferenceEvent("user");
  await waitForTitles(library.ownReferences$, [
    "Second owned",
    "Owned baseline",
  ]);

  control.replace([added, own]);
  triggerReferenceEvent("org");
  await waitForTitles(library.organizationReferences$, []);
  await expect(context.store.get(sharedResolution$)).resolves.toBeNull();
  const retained = (await context.store.get(library.pickerItems$)).find(
    ({ reference }) => {
      return reference.id === own.id;
    },
  );
  expect(retained?.imageBuffers).toBe(ownPickerItem.imageBuffers);
  expect(
    retained && context.store.get(retained.imageBuffers.card.state$).active,
  ).toStrictEqual(loaded);
});

test("upload an image-reference source and create a row without composer or thread side effects", async () => {
  const { chat, control, library } = await setupImageReferencePage([]);
  let completed = 0;
  context.mocks.api(
    imageReferencesContract.prepareUpload,
    ({ body, respond }) => {
      expect(body).toStrictEqual({
        filename: "canonical.png",
        contentType: "image/png",
        size: 9,
      });
      return respond(200, {
        sourceFileId: sourceFileId(2),
        uploadUrl: "https://uploads.example.test/canonical.png",
        uploadHeaders: { "x-upload-token": "private" },
      });
    },
  );
  context.mocks.http.put(
    "https://uploads.example.test/canonical.png",
    ({ request }) => {
      expect(request.headers.get("x-upload-token")).toBe("private");
      return new HttpResponse(null, { status: 200 });
    },
  );
  context.mocks.api(uploadsContract.complete, ({ body, respond }) => {
    completed += 1;
    return respond(200, {
      id: body.id,
      filename: "canonical.png",
      contentType: "image/png",
      size: 9,
      url: `https://files.example.test/${body.id}`,
    });
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.type(composer, "Keep this draft");

  await context.store.set(
    library.uploadAndCreate$,
    {
      file: new File(["canonical"], "canonical.png", { type: "image/png" }),
      title: "Canonical image",
      visibility: "private",
    },
    context.signal,
  );

  expect(completed).toBe(1);
  expect(control.requests.creates).toStrictEqual([
    {
      sourceFileId: sourceFileId(2),
      title: "Canonical image",
      visibility: "private",
    },
  ]);
  expect(
    context.store.get(agentChatComposerSignals$).draft.attachments$,
  ).toBeDefined();
  expect(
    context.store.get(
      context.store.get(agentChatComposerSignals$).draft.attachments$,
    ),
  ).toStrictEqual([]);
  expect(composer).toHaveTextContent("Keep this draft");
  expect(chat.sentMessages).toStrictEqual([]);
  expect(chat.threadCreates).toStrictEqual([]);
  expect(chat.runPrompts).toStrictEqual([]);
});

test("reject unsupported source formats before preparing an upload", async () => {
  const { control, library } = await setupImageReferencePage([]);

  await expect(
    context.store.set(
      library.uploadAndCreate$,
      {
        file: new File(["document"], "reference.pdf", {
          type: "application/pdf",
        }),
        title: "Unsupported",
        visibility: "private",
      },
      context.signal,
    ),
  ).rejects.toThrow("Image must be a PNG, JPEG, or WebP file");
  expect(control.requests.creates).toStrictEqual([]);
});
