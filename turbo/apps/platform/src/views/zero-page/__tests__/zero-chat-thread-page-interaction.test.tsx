import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import {
  zeroBillingCheckoutContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import {
  chatMessagesContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { hasSubscription } from "../../../mocks/ably.ts";
import { pathname } from "../../../signals/location.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "thread-test-1";

function queryButtonByText(text: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === text;
  });
}

async function findButtonByText(text: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(queryButtonByText(text)).toBeDefined();
  });
  return queryButtonByText(text)!;
}

function paidBillingStatus(credits: number): BillingStatusResponse {
  return {
    tier: "pro",
    credits,
    subscriptionStatus: "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    hasSubscription: true,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: {
      expiringNextCycle: 0,
      nextExpiryDate: null,
    },
    creditBreakdown: [],
    creditGrants: [],
  };
}

beforeEach(() => {
  vi.stubEnv("VITE_API_URL", "https://www.vm0.ai");
  vi.stubEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm7.io");
  server.use(
    http.get("https://example.com/avatar.png", () => {
      return new HttpResponse("avatar", {
        headers: { "Content-Type": "image/png" },
      });
    }),
  );
});

// CHAT-S-044: Sending state affects ChatThreadComposer button display
describe("zero chat thread page - sending state affects composer button display", () => {
  it("shows Stop button while sending and Send button after run completes (CHAT-S-044)", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.queryByLabelText("Send")).not.toBeInTheDocument();
    });

    // Wait for loadPagedMessages$ to subscribe before completing
    await waitFor(() => {
      expect(
        hasSubscription(`chatThreadMessageCreated:${THREAD_ID}`),
      ).toBeTruthy();
    });

    ctrl.completeRun("Done");

    await waitFor(() => {
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page - insufficient credits card", () => {
  const seedInsufficientCreditsMessages = () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "blocked by credits",
          error: "insufficient_credits",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Insufficient credits.",
          error: "insufficient_credits",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });
  };

  it("starts Pro checkout directly for free-tier workspaces", async () => {
    let capturedCheckoutBody: unknown;
    setMockBillingStatus({
      tier: "free",
      credits: 0,
      subscriptionStatus: null,
      hasSubscription: false,
    });
    server.use(
      mockApi(zeroBillingCheckoutContract.create, ({ body, respond }) => {
        capturedCheckoutBody = body;
        return respond(200, {
          url: "https://checkout.stripe.com/test?tier=pro",
        });
      }),
    );
    seedInsufficientCreditsMessages();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const upgradeButton = await findButtonByText("Upgrade to Pro");
    click(upgradeButton);

    await waitFor(() => {
      expect(capturedCheckoutBody).toMatchObject({
        tier: "pro",
        successUrl: expect.stringContaining(
          "billing_session_id={CHECKOUT_SESSION_ID}",
        ),
      });
    });
  });

  it("starts Pro checkout for pro-suspend workspaces even with credits", async () => {
    let capturedCheckoutBody: unknown;
    setMockBillingStatus({
      tier: "pro-suspend",
      credits: 20_000,
      subscriptionStatus: null,
      hasSubscription: false,
    });
    server.use(
      mockApi(zeroBillingCheckoutContract.create, ({ body, respond }) => {
        capturedCheckoutBody = body;
        return respond(200, {
          url: "https://checkout.stripe.com/test?tier=pro",
        });
      }),
    );
    seedInsufficientCreditsMessages();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByText("Upgrade to Pro to run Zero"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Credits available")).not.toBeInTheDocument();
    const upgradeButton = await findButtonByText("Upgrade to Pro");
    click(upgradeButton);

    await waitFor(() => {
      expect(capturedCheckoutBody).toMatchObject({
        tier: "pro",
      });
    });
  });

  it("asks non-admins to have an admin upgrade free-tier workspaces", async () => {
    const createCheckout = vi.fn();
    setMockOrg({ role: "member" });
    setMockBillingStatus({
      tier: "free",
      credits: 0,
      subscriptionStatus: null,
      hasSubscription: false,
    });
    server.use(
      mockApi(zeroBillingCheckoutContract.create, ({ respond }) => {
        createCheckout();
        return respond(200, {
          url: "https://checkout.stripe.com/test?tier=pro",
        });
      }),
    );
    seedInsufficientCreditsMessages();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByText(
        "Ask a workspace admin to upgrade to Pro so you can keep chatting with Zero.",
      ),
    ).resolves.toBeInTheDocument();
    expect(queryButtonByText("Upgrade to Pro")).toBeUndefined();
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it("starts fixed credit checkout for paid-tier workspaces", async () => {
    let capturedCreditCheckoutBody: unknown;
    setMockBillingStatus({
      tier: "pro",
      credits: 0,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    server.use(
      mockApi(zeroBillingCreditCheckoutContract.create, ({ body, respond }) => {
        capturedCreditCheckoutBody = body;
        return respond(200, {
          url: "https://checkout.stripe.com/test?credits=200000",
        });
      }),
    );
    seedInsufficientCreditsMessages();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const creditButton = await findButtonByText("$200");
    click(creditButton);

    await waitFor(() => {
      expect(capturedCreditCheckoutBody).toMatchObject({
        credits: 200_000,
        successUrl: expect.stringContaining(
          "credit_checkout_session_id={CHECKOUT_SESSION_ID}",
        ),
      });
    });
  });

  it("asks non-admins to have an admin add credits to paid workspaces", async () => {
    const createCreditCheckout = vi.fn();
    setMockOrg({ role: "member" });
    setMockBillingStatus({
      tier: "pro",
      credits: 0,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    server.use(
      mockApi(zeroBillingCreditCheckoutContract.create, ({ respond }) => {
        createCreditCheckout();
        return respond(200, {
          url: "https://checkout.stripe.com/test?credits=200000",
        });
      }),
    );
    seedInsufficientCreditsMessages();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByText(
        "Ask a workspace admin to add credits so you can keep chatting with Zero.",
      ),
    ).resolves.toBeInTheDocument();
    expect(queryButtonByText("$100")).toBeUndefined();
    expect(queryButtonByText("Custom")).toBeUndefined();
    expect(createCreditCheckout).not.toHaveBeenCalled();
  });

  it("starts custom amount credit checkout for paid-tier workspaces", async () => {
    let capturedCreditCheckoutBody: unknown;
    setMockBillingStatus({
      tier: "pro",
      credits: 0,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    server.use(
      mockApi(zeroBillingCreditCheckoutContract.create, ({ body, respond }) => {
        capturedCreditCheckoutBody = body;
        return respond(200, {
          url: "https://checkout.stripe.com/test?credits=custom",
        });
      }),
    );
    seedInsufficientCreditsMessages();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const customButton = await findButtonByText("Custom");
    click(customButton);
    await expect(
      screen.findByLabelText("Custom dollar amount"),
    ).resolves.toBeInTheDocument();
    const buyButton = await findButtonByText("Buy");
    click(buyButton);

    await waitFor(() => {
      expect(capturedCreditCheckoutBody).toMatchObject({
        credits: 100_000,
        customAmount: true,
        successUrl: expect.stringContaining(
          "credit_checkout_session_id={CHECKOUT_SESSION_ID}",
        ),
      });
    });
  });

  it("refreshes stale positive billing status after an insufficient-credit send", async () => {
    const user = userEvent.setup();
    let billingRequestCount = 0;
    let currentCredits = 20_000;
    let showInsufficientCreditMessages = false;
    server.use(
      mockApi(zeroBillingStatusContract.get, ({ respond }) => {
        billingRequestCount++;
        return respond(200, paidBillingStatus(currentCredits));
      }),
    );
    mockChatLifecycle({ threadId: THREAD_ID });
    server.use(
      mockApi(chatMessagesContract.send, ({ respond }) => {
        currentCredits = 0;
        showInsufficientCreditMessages = true;
        return respond(201, {
          runId: null,
          threadId: THREAD_ID,
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(200, {
          messages: showInsufficientCreditMessages
            ? [
                {
                  id: "msg-insufficient-user",
                  role: "user",
                  content: "blocked by credits",
                  error: "insufficient_credits",
                  createdAt: "2026-03-10T00:00:00Z",
                },
                {
                  id: "msg-insufficient-assistant",
                  role: "assistant",
                  content: "Insufficient credits.",
                  error: "insufficient_credits",
                  createdAt: "2026-03-10T00:00:01Z",
                },
              ]
            : [],
          hasHistoryBefore: false,
        });
      }),
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(billingRequestCount).toBeGreaterThanOrEqual(1);
    });

    await sendMessageInUI(user, textarea, "blocked by credits");

    await expect(
      screen.findByText("You're out of credits"),
    ).resolves.toBeInTheDocument();
    await expect(screen.findByText("$100")).resolves.toBeInTheDocument();
    expect(screen.queryByText("Credits available")).not.toBeInTheDocument();
    expect(billingRequestCount).toBeGreaterThanOrEqual(2);
  });

  it("shows a success state when credits are available again", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    seedInsufficientCreditsMessages();

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expect(
      screen.findByText("Credits available"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        "Your credits have been added. You can continue chatting with Zero.",
      ),
    ).toBeInTheDocument();
    expect(queryButtonByText("$100")).toBeUndefined();
  });
});

// CHAT-I-049 / CHAT-I-050: Image preview link opens ImageLightbox
describe("zero chat thread page - image attachment opens lightbox", () => {
  it("clicking image preview link opens ImageLightbox (CHAT-I-049, CHAT-I-050)", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            "[Attached file: photo.png](https://example.com/photo.png)\nDownload with: curl https://example.com/photo.png\n",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByAltText("photo.png")).toBeInTheDocument();
    });

    const imageLink = screen.getByLabelText("Preview photo.png");
    expect(imageLink).toHaveAttribute("href", "https://example.com/photo.png");
    click(imageLink);

    await waitFor(() => {
      const lightboxImg = screen.getAllByRole("img").find((img) => {
        return (
          (img as HTMLImageElement).src === "https://example.com/photo.png"
        );
      });
      expect(lightboxImg).toBeInTheDocument();
    });
  });

  it("downloads a CDN image from the lightbox", async () => {
    const imageUrl = "https://cdn.example.com/photo.png";
    server.use(
      http.get(imageUrl, () => {
        return new HttpResponse(new Blob(["img"], { type: "image/png" }), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }),
    );
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: photo.png](${imageUrl})\nDownload with: curl ${imageUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const imageLink = await waitFor(() => {
      return screen.getByLabelText("Preview photo.png");
    });
    expect(imageLink).toHaveAttribute("href", imageUrl);
    click(imageLink);

    const downloadButton = await waitFor(() => {
      return screen.getByLabelText("Download");
    });
    click(downloadButton);

    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledOnce();
      expect(anchorClickSpy).toHaveBeenCalledWith();
    });
  });
});

describe("zero chat thread page - document preview opens global lightbox", () => {
  it("clicking html platform file url preview opens the shared attachment lightbox", async () => {
    const htmlUrl =
      "https://www.vm0.ai/f/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/report.html";
    const publicHtmlUrl =
      "https://cdn.vm7.io/artifacts/user_123/3a474c61-ffe4-4e56-b9e7-0185b3dba9f7/report.html";
    const writeTextSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[report](${htmlUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const previewButton = await waitFor(() => {
      return screen.getByLabelText("Open html preview for report");
    });

    await userEvent.click(previewButton);

    await waitFor(() => {
      expect(screen.getByTestId("attachment-lightbox")).toBeInTheDocument();
      expect(previewButton).toHaveAttribute("href", publicHtmlUrl);
      const iframe = screen.getByTitle("report preview");
      expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
      expect(iframe).toHaveAttribute("scrolling", "yes");
      expect(iframe).toHaveClass(
        "relative",
        "z-10",
        "h-[min(78vh,900px)]",
        "max-w-full",
        "overflow-x-hidden",
        "overscroll-contain",
      );
      expect(iframe.parentElement).toHaveClass(
        "max-w-full",
        "overflow-hidden",
        "overscroll-contain",
      );
      expect(iframe.parentElement).not.toHaveClass(
        "h-[min(78vh,900px)]",
        "overflow-y-auto",
      );
    });

    await userEvent.click(screen.getByLabelText("Copy link"));
    expect(writeTextSpy).toHaveBeenCalledWith(publicHtmlUrl);
  });
});

// CHAT-I-052: Copy message button writes message content to clipboard
describe("zero chat thread page - copy message button", () => {
  it("clicking copy button writes message content to clipboard (CHAT-I-052)", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          runId: "run-legacy-1",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Hello world",
          runId: "run-legacy-1",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const copyButton = await waitFor(() => {
      const buttons = screen.getAllByLabelText("Copy message");
      return buttons[buttons.length - 1] as HTMLElement;
    });
    click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Hello world");
    });

    // The message should still be visible after copying (page remains stable)
    expect(screen.getAllByLabelText("Copy message").length).toBeGreaterThan(0);
  });
});

// CHAT-N-053: View activity logs Link navigates to /activities/:id
describe("zero chat thread page - view activity logs link", () => {
  it("navigates to /activities/:id when view run logs link is clicked (CHAT-N-053)", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: "Hello world",
          runId: "run-legacy-1",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByLabelText("View run logs")).toBeInTheDocument();
    });

    const logLink = screen.getByLabelText("View run logs");
    click(logLink);

    await waitFor(() => {
      expect(pathname()).toBe("/activities/run-legacy-1");
    });
  });
});

describe("zero chat thread page - manual history loading", () => {
  it("loads older messages only after clicking Load history", async () => {
    mockChatLifecycle({
      historyMessages: [
        {
          role: "user",
          content: "Older message",
          createdAt: "2026-03-09T23:59:59Z",
        },
      ],
      chatMessages: [
        {
          role: "assistant",
          content: "Newest message",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Newest message")).toBeInTheDocument();
    });
    expect(screen.queryByText("Older message")).not.toBeInTheDocument();

    click(await screen.findByText("Load history"));

    await waitFor(() => {
      expect(screen.getByText("Older message")).toBeInTheDocument();
    });
  });
});

// CHAT-I-055: Attachment preview chips do not navigate away from the page
describe("zero chat thread page - file attachment preview does not navigate away", () => {
  it("clicking the attachment chip opens preview without changing the pathname (CHAT-I-055)", async () => {
    server.use(
      http.get("https://example.com/document.pdf", () => {
        return new HttpResponse("%PDF-test", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            "[Attached file: document.pdf](https://example.com/document.pdf)\nDownload with: curl https://example.com/document.pdf\n",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const previewChip = await waitFor(() => {
      return screen.getByTitle("document.pdf");
    });

    const initialPathname = pathname();
    click(previewChip);

    await waitFor(() => {
      expect(pathname()).toBe(initialPathname);
      expect(screen.getByTitle("document.pdf preview")).toBeInTheDocument();
    });
  });
});
