import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  zeroAgentInstructionsContract,
  zeroAgentsByIdContract,
  type ZeroAgentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "a0000000-0000-4000-a000-000000000020";
const AVATAR_SVG_PRELOAD_CACHE_KEY = "vm0AvatarSvgPreloadCache";

function resetAvatarSvgPreloadCache(): void {
  Reflect.deleteProperty(globalThis, AVATAR_SVG_PRELOAD_CACHE_KEY);
}

function trackAvatarSvgImagePreloads(): {
  readonly srcs: readonly string[];
  readonly restore: () => void;
} {
  const srcs: string[] = [];
  const originalGlobalImage = Object.getOwnPropertyDescriptor(
    globalThis,
    "Image",
  );
  const originalWindowImage = Object.getOwnPropertyDescriptor(window, "Image");

  class TestImagePreload {
    decoding = "";
    fetchPriority = "";
    #src = "";

    get src(): string {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      srcs.push(value);
    }
  }

  const imageConstructor = TestImagePreload as unknown as typeof Image;
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: imageConstructor,
    writable: true,
  });
  Object.defineProperty(window, "Image", {
    configurable: true,
    value: imageConstructor,
    writable: true,
  });

  return {
    srcs,
    restore: () => {
      if (originalGlobalImage) {
        Object.defineProperty(globalThis, "Image", originalGlobalImage);
      } else {
        Reflect.deleteProperty(globalThis, "Image");
      }
      if (originalWindowImage) {
        Object.defineProperty(window, "Image", originalWindowImage);
      } else {
        Reflect.deleteProperty(window, "Image");
      }
    },
  };
}

function mockImmediateIdleCallback(): () => void {
  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(
    window,
    "requestIdleCallback",
  );
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: (callback: IdleRequestCallback): number => {
      callback({
        didTimeout: false,
        timeRemaining: () => {
          return 50;
        },
      });
      return 1;
    },
    writable: true,
  });

  return () => {
    if (originalRequestIdleCallback) {
      Object.defineProperty(
        window,
        "requestIdleCallback",
        originalRequestIdleCallback,
      );
    } else {
      Reflect.deleteProperty(window, "requestIdleCallback");
    }
  };
}

function mockSaveDataPreference(saveData: boolean): () => void {
  const originalConnection = Object.getOwnPropertyDescriptor(
    navigator,
    "connection",
  );
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: { saveData },
  });

  return () => {
    if (originalConnection) {
      Object.defineProperty(navigator, "connection", originalConnection);
    } else {
      Reflect.deleteProperty(navigator, "connection");
    }
  };
}

function avatarSvgPreloadSrcs(srcs: readonly string[]): string[] {
  return srcs.filter((src) => {
    return src.includes("/platform/views/zero-page/assets/avatar-svg/");
  });
}

function uniqueAvatarSvgPreloadSrcs(srcs: readonly string[]): string[] {
  return Array.from(new Set(avatarSvgPreloadSrcs(srcs)));
}

function prepareAgentProfile(): void {
  let detail: ZeroAgentResponse = {
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    description: "A helpful agent",
    displayName: "Research Agent",
    sound: "professional",
    avatarUrl: "preset:0",
    visibility: "public",
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
  };

  context.mocks.data.team([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: detail.displayName,
      description: detail.description,
      sound: detail.sound,
      avatarUrl: detail.avatarUrl,
      visibility: "public",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
  ]);
  context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.api(
    zeroAgentsByIdContract.updateMetadata,
    ({ body, respond }) => {
      detail = { ...detail, ...body };
      return respond(200, detail);
    },
  );
  context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

describe("zero settings tab", () => {
  beforeEach(() => {
    resetAvatarSvgPreloadCache();
  });

  afterEach(() => {
    resetAvatarSvgPreloadCache();
  });

  it("preloads avatar SVG layers after opening Avatar Maker", async () => {
    prepareAgentProfile();
    const imagePreloads = trackAvatarSvgImagePreloads();
    const restoreIdleCallback = mockImmediateIdleCallback();

    try {
      detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

      const trigger = await screen.findByLabelText("Create custom avatar");
      expect(avatarSvgPreloadSrcs(imagePreloads.srcs)).toHaveLength(0);

      click(trigger);

      await waitFor(() => {
        expect(uniqueAvatarSvgPreloadSrcs(imagePreloads.srcs)).toHaveLength(
          225,
        );
      });

      const allAvatarSrcs = avatarSvgPreloadSrcs(imagePreloads.srcs);
      const uniqueAvatarSrcs = uniqueAvatarSvgPreloadSrcs(imagePreloads.srcs);
      expect(allAvatarSrcs).toHaveLength(225);
      expect(
        uniqueAvatarSrcs.filter((src) => {
          return src.includes("/head-r");
        }),
      ).toHaveLength(25);
      expect(
        uniqueAvatarSrcs.filter((src) => {
          return src.includes("/face-r");
        }),
      ).toHaveLength(75);
      expect(
        uniqueAvatarSrcs.filter((src) => {
          return src.includes("/hair-r");
        }),
      ).toHaveLength(125);
      expect(
        uniqueAvatarSrcs.some((src) => {
          return src.includes("/web/assets/avatar-svg/");
        }),
      ).toBeFalsy();

      click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(screen.queryAllByText("Give your agent a face")).toHaveLength(0);
      });

      click(screen.getByLabelText("Create custom avatar"));

      await waitFor(() => {
        expect(
          screen.getAllByText("Give your agent a face").length,
        ).toBeGreaterThan(0);
      });
      expect(avatarSvgPreloadSrcs(imagePreloads.srcs)).toHaveLength(225);
    } finally {
      restoreIdleCallback();
      imagePreloads.restore();
    }
  });

  it("does not preload the full avatar SVG catalog when save-data is enabled", async () => {
    prepareAgentProfile();
    const imagePreloads = trackAvatarSvgImagePreloads();
    const restoreIdleCallback = mockImmediateIdleCallback();
    const restoreSaveDataPreference = mockSaveDataPreference(true);

    try {
      detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

      click(await screen.findByLabelText("Create custom avatar"));

      await waitFor(() => {
        expect(
          screen.getAllByText("Give your agent a face").length,
        ).toBeGreaterThan(0);
      });
      expect(avatarSvgPreloadSrcs(imagePreloads.srcs)).toHaveLength(0);
    } finally {
      restoreSaveDataPreference();
      restoreIdleCallback();
      imagePreloads.restore();
    }
  });

  it("creates and saves a custom avatar from the profile page", async () => {
    prepareAgentProfile();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    click(await screen.findByLabelText("Create custom avatar"));

    await waitFor(() => {
      expect(
        screen.getAllByText("Give your agent a face").length,
      ).toBeGreaterThan(0);
      expect(screen.getByText("Angle")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Randomize avatar"));
    click(screen.getByLabelText("Next step"));

    await waitFor(() => {
      expect(screen.getByText("Skin")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));
    click(screen.getByLabelText("Next step"));

    await waitFor(() => {
      expect(screen.getByText("Mood")).toBeInTheDocument();
    });

    click(screen.getByText("Chill"));
    click(screen.getByText("Use this avatar"));

    await waitFor(() => {
      expect(screen.queryAllByText("Give your agent a face")).toHaveLength(0);
      expect(screen.getByText("Profile saved")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Create custom avatar"));

    await waitFor(() => {
      expect(
        screen.getAllByText("Give your agent a face").length,
      ).toBeGreaterThan(0);
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryAllByText("Give your agent a face")).toHaveLength(0);
    });
  });

  it("saves, discards, and confirms visible agent profile edits", async () => {
    prepareAgentProfile();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}?tab=profile` });

    const nameInput = await screen.findByDisplayValue("Research Agent");
    await fill(nameInput, "Research Lead");
    await fill(
      screen.getByLabelText("Description"),
      "Helps with release research",
    );
    click(screen.getByText("Friendly"));
    click(screen.getByLabelText("Make public"));

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
      expect(screen.getByText("Warm and approachable")).toBeInTheDocument();
      expect(screen.getByLabelText("Make public")).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    click(screen.getByText("Save"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("Research Lead")).toBeInTheDocument();
      expect(
        screen.getByDisplayValue("Helps with release research"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Make public")).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });

    await fill(screen.getByDisplayValue("Research Lead"), "Temporary Name");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText("Discard"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("Research Lead")).toBeInTheDocument();
    });

    click(screen.getByText("Delete agent"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByText(/instructions, automations, and all associated data/u),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByText(
          /instructions, automations, and all associated data/u,
        ),
      ).not.toBeInTheDocument();
    });
  });
});
