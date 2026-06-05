import type StripeSDK from "stripe";
import { computed } from "ccstate";
import { vi, type Mock } from "vitest";

import { mockStripeClient } from "../signals/external/stripe-client";

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type BooleanMock = Mock<(...args: unknown[]) => boolean>;
type SyncMock = Mock<(...args: unknown[]) => void>;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;

export interface ApiTestMocks {
  readonly axiom: {
    readonly flush: AsyncMock;
    readonly ingest: BooleanMock;
    readonly query: AsyncMock;
    readonly sdkIngest: UnknownMock;
  };
  readonly axiomLogging: {
    readonly debug: SyncMock;
    readonly info: SyncMock;
    readonly warn: SyncMock;
    readonly error: SyncMock;
    readonly flush: AsyncMock;
  };
  readonly ably: {
    readonly publish: AsyncMock;
    readonly createTokenRequest: AsyncMock;
  };
  readonly clerk: {
    readonly authenticateRequest: AsyncMock;
    readonly verifyWebhook: AsyncMock;
    readonly organizations: {
      readonly createOrganizationInvitation: AsyncMock;
      readonly getOrganization: AsyncMock;
      readonly getOrganizationInvitationList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
      readonly deleteOrganizationMembership: AsyncMock;
      readonly deleteOrganizationLogo: AsyncMock;
      readonly revokeOrganizationInvitation: AsyncMock;
      readonly deleteOrganization: AsyncMock;
      readonly updateOrganization: AsyncMock;
      readonly updateOrganizationMembership: AsyncMock;
      readonly updateOrganizationLogo: AsyncMock;
    };
    readonly users: {
      readonly getUserList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
      readonly updateUser: AsyncMock;
    };
    readonly signInTokens: {
      readonly createSignInToken: AsyncMock;
    };
  };
  readonly googleGenAi: {
    readonly constructorArgs: SyncMock;
    readonly generateContent: AsyncMock;
  };
  readonly s3: {
    readonly send: AsyncMock;
    readonly getSignedUrl: AsyncMock;
    readonly clientConfig: SyncMock;
  };
  readonly resend: {
    readonly send: AsyncMock;
    readonly get: AsyncMock;
    readonly receivingGet: AsyncMock;
    readonly attachmentsList: AsyncMock;
  };
  readonly slack: {
    readonly assistant: {
      readonly threads: {
        readonly setStatus: AsyncMock;
      };
    };
    readonly chat: {
      readonly postMessage: AsyncMock;
      readonly postEphemeral: AsyncMock;
    };
    readonly conversations: {
      readonly list: AsyncMock;
      readonly open: AsyncMock;
      readonly history: AsyncMock;
      readonly replies: AsyncMock;
    };
    readonly files: {
      readonly info: AsyncMock;
      readonly getUploadURLExternal: AsyncMock;
      readonly completeUploadExternal: AsyncMock;
    };
    readonly oauth: {
      readonly v2: {
        readonly access: AsyncMock;
      };
    };
    readonly views: {
      readonly publish: AsyncMock;
      readonly open: AsyncMock;
    };
    readonly users: {
      readonly info: AsyncMock;
    };
    readonly fetchFile: AsyncMock;
  };
  readonly stripe: {
    readonly invoices: {
      readonly list: AsyncMock;
      readonly create: AsyncMock;
      readonly finalizeInvoice: AsyncMock;
      readonly pay: AsyncMock;
    };
    readonly invoiceItems: {
      readonly create: AsyncMock;
    };
    readonly customers: {
      readonly retrieve: AsyncMock;
      readonly create: AsyncMock;
    };
    readonly subscriptions: {
      readonly list: AsyncMock;
      readonly retrieve: AsyncMock;
      readonly update: AsyncMock;
      readonly cancel: AsyncMock;
    };
    readonly subscriptionSchedules: {
      readonly create: AsyncMock;
      readonly update: AsyncMock;
      readonly release: AsyncMock;
    };
    readonly webhooks: {
      readonly constructEvent: UnknownMock;
    };
    readonly checkout: {
      readonly sessions: {
        readonly create: AsyncMock;
        readonly retrieve: AsyncMock;
        readonly expire: AsyncMock;
      };
    };
    readonly billingPortal: {
      readonly sessions: {
        readonly create: AsyncMock;
      };
    };
    readonly coupons: {
      readonly retrieve: AsyncMock;
    };
    readonly prices: {
      readonly retrieve: AsyncMock;
      readonly create: AsyncMock;
    };
  };
  readonly vercelOidc: {
    readonly getToken: AsyncMock;
  };
  readonly webpush: {
    readonly sendNotification: AsyncMock;
    readonly setVapidDetails: SyncMock;
  };
  readonly telegram: {
    readonly getMe: AsyncMock;
    readonly getFile: AsyncMock;
    readonly deleteWebhook: AsyncMock;
    readonly setWebhook: AsyncMock;
    readonly setMyCommands: AsyncMock;
    readonly getUserProfilePhotos: AsyncMock;
  };
  readonly otel: {
    readonly registerOTel: SyncMock;
  };
  readonly sentry: {
    readonly captureException: SyncMock;
    readonly httpIntegration: Mock<(...args: unknown[]) => unknown>;
    readonly init: SyncMock;
    readonly nativeNodeFetchIntegration: Mock<(...args: unknown[]) => unknown>;
  };
}

const apiTestMocks: ApiTestMocks = vi.hoisted((): ApiTestMocks => {
  const axiom = {
    flush: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    ingest: vi.fn<(...args: unknown[]) => boolean>(),
    query: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    sdkIngest: vi.fn<(...args: unknown[]) => unknown>(),
  };

  const clerk = {
    authenticateRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    verifyWebhook: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    organizations: {
      createOrganizationInvitation:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganization: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationInvitationList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      deleteOrganizationMembership:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      deleteOrganizationLogo: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      revokeOrganizationInvitation:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      deleteOrganization: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      updateOrganization: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      updateOrganizationMembership:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      updateOrganizationLogo: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    users: {
      getUserList: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      updateUser: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    signInTokens: {
      createSignInToken: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  };

  const slack = {
    assistant: {
      threads: {
        setStatus: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
    },
    chat: {
      postMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      postEphemeral: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    conversations: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      open: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      history: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      replies: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    files: {
      info: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getUploadURLExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      completeUploadExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    oauth: {
      v2: {
        access: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
    },
    views: {
      publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      open: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    users: {
      info: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    fetchFile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  const stripe = {
    invoices: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      finalizeInvoice: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      pay: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    invoiceItems: {
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    customers: {
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    subscriptions: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      cancel: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    subscriptionSchedules: {
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      release: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    webhooks: {
      constructEvent: vi.fn<(...args: unknown[]) => unknown>(),
    },
    checkout: {
      sessions: {
        create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        expire: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      },
    },
    coupons: {
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    prices: {
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      create: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  };

  const telegram = {
    getMe: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getFile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    deleteWebhook: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    setWebhook: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    setMyCommands: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getUserProfilePhotos: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  const axiomLogging = {
    debug: vi.fn<(...args: unknown[]) => void>(),
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
    flush: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  return {
    ably: {
      publish: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      createTokenRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    axiom,
    axiomLogging,
    clerk,
    googleGenAi: {
      constructorArgs: vi.fn<(...args: unknown[]) => void>(),
      generateContent: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    s3: {
      send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getSignedUrl: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      clientConfig: vi.fn<(...args: unknown[]) => void>(),
    },
    resend: {
      send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      get: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      receivingGet: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      attachmentsList: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    slack,
    stripe,
    vercelOidc: {
      getToken: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    webpush: {
      sendNotification: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      setVapidDetails: vi.fn<(...args: unknown[]) => void>(),
    },
    telegram,
    otel: {
      registerOTel: vi.fn<(...args: unknown[]) => void>(),
    },
    sentry: {
      captureException: vi.fn<(...args: unknown[]) => void>(),
      httpIntegration: vi.fn<(...args: unknown[]) => unknown>((options) => {
        return { name: "Http", options };
      }),
      init: vi.fn<(...args: unknown[]) => void>(),
      nativeNodeFetchIntegration: vi.fn<(...args: unknown[]) => unknown>(
        (options) => {
          return { name: "NodeFetch", options };
        },
      ),
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class HeadObjectCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class ListObjectsV2Command {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class DeleteObjectsCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class PutObjectCommand {
    readonly input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class S3Client {
    constructor(config: unknown) {
      apiTestMocks.s3.clientConfig(config);
    }

    send(command: unknown): Promise<unknown> {
      return apiTestMocks.s3.send(command);
    }
  }

  return {
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => {
  return {
    getSignedUrl: (...args: unknown[]): Promise<unknown> => {
      return apiTestMocks.s3.getSignedUrl(...args);
    },
  };
});

vi.mock("@clerk/backend", () => {
  return {
    createClerkClient: () => {
      return apiTestMocks.clerk;
    },
  };
});

vi.mock("@clerk/backend/webhooks", () => {
  return {
    verifyWebhook: (...args: unknown[]): Promise<unknown> => {
      return apiTestMocks.clerk.verifyWebhook(...args);
    },
  };
});

vi.mock("@google/genai", () => {
  class GoogleGenAI {
    readonly models = {
      generateContent: apiTestMocks.googleGenAi.generateContent,
    };

    constructor(args: unknown) {
      apiTestMocks.googleGenAi.constructorArgs(args);
    }
  }

  return { GoogleGenAI };
});

vi.mock("@vercel/oidc", () => {
  return {
    getVercelOidcToken: (): Promise<unknown> => {
      return apiTestMocks.vercelOidc.getToken();
    },
  };
});

vi.mock("web-push", async (importActual) => {
  const actual = await importActual<typeof import("web-push")>();
  return {
    ...actual,
    default: {
      sendNotification: (...args: unknown[]): Promise<unknown> => {
        return apiTestMocks.webpush.sendNotification(...args);
      },
      setVapidDetails: (...args: unknown[]): void => {
        apiTestMocks.webpush.setVapidDetails(...args);
      },
    },
    sendNotification: (...args: unknown[]): Promise<unknown> => {
      return apiTestMocks.webpush.sendNotification(...args);
    },
    setVapidDetails: (...args: unknown[]): void => {
      apiTestMocks.webpush.setVapidDetails(...args);
    },
  };
});

vi.mock("resend", () => {
  return {
    Resend: vi.fn(function (): unknown {
      return {
        emails: {
          send: apiTestMocks.resend.send,
          get: apiTestMocks.resend.get,
          receiving: {
            get: apiTestMocks.resend.receivingGet,
            attachments: { list: apiTestMocks.resend.attachmentsList },
          },
        },
      };
    }),
  };
});

vi.mock("ably", () => {
  class MockRest {
    readonly channels = {
      get: () => {
        return { publish: apiTestMocks.ably.publish };
      },
    };
    readonly auth = {
      createTokenRequest: (...args: unknown[]): Promise<unknown> => {
        return apiTestMocks.ably.createTokenRequest(...args);
      },
    };
  }
  return { default: { Rest: MockRest } };
});

vi.mock("@sentry/node", () => {
  return apiTestMocks.sentry;
});

vi.mock("@vercel/otel", () => {
  return apiTestMocks.otel;
});

vi.mock("stripe", async (importOriginal) => {
  // Preserve the real `Stripe.errors.*` classes so route-level `instanceof`
  // checks (and tests constructing `new Stripe.errors.StripeInvalidRequestError`)
  // continue to work; only the constructor surface is stubbed.
  const actual = await importOriginal<typeof import("stripe")>();
  const MockStripe = Object.assign(
    vi.fn(() => {
      return {
        invoices: {
          list: apiTestMocks.stripe.invoices.list,
          create: apiTestMocks.stripe.invoices.create,
          finalizeInvoice: apiTestMocks.stripe.invoices.finalizeInvoice,
          pay: apiTestMocks.stripe.invoices.pay,
        },
        invoiceItems: {
          create: apiTestMocks.stripe.invoiceItems.create,
        },
        customers: {
          retrieve: apiTestMocks.stripe.customers.retrieve,
          create: apiTestMocks.stripe.customers.create,
        },
        subscriptions: {
          list: apiTestMocks.stripe.subscriptions.list,
          retrieve: apiTestMocks.stripe.subscriptions.retrieve,
          update: apiTestMocks.stripe.subscriptions.update,
          cancel: apiTestMocks.stripe.subscriptions.cancel,
        },
        subscriptionSchedules: {
          create: apiTestMocks.stripe.subscriptionSchedules.create,
          update: apiTestMocks.stripe.subscriptionSchedules.update,
          release: apiTestMocks.stripe.subscriptionSchedules.release,
        },
        webhooks: {
          constructEvent: apiTestMocks.stripe.webhooks.constructEvent,
        },
        checkout: {
          sessions: {
            create: apiTestMocks.stripe.checkout.sessions.create,
            retrieve: apiTestMocks.stripe.checkout.sessions.retrieve,
            expire: apiTestMocks.stripe.checkout.sessions.expire,
          },
        },
        billingPortal: {
          sessions: {
            create: apiTestMocks.stripe.billingPortal.sessions.create,
          },
        },
        coupons: {
          retrieve: apiTestMocks.stripe.coupons.retrieve,
        },
        prices: {
          retrieve: apiTestMocks.stripe.prices.retrieve,
          create: apiTestMocks.stripe.prices.create,
        },
      };
    }),
    { errors: actual.default.errors },
  );
  return { default: MockStripe };
});

vi.mock("@slack/web-api", () => {
  return {
    WebClient: vi.fn(function (): unknown {
      return {
        assistant: {
          threads: {
            setStatus: apiTestMocks.slack.assistant.threads.setStatus,
          },
        },
        chat: {
          postMessage: apiTestMocks.slack.chat.postMessage,
          postEphemeral: apiTestMocks.slack.chat.postEphemeral,
        },
        conversations: {
          list: apiTestMocks.slack.conversations.list,
          open: apiTestMocks.slack.conversations.open,
          history: apiTestMocks.slack.conversations.history,
          replies: apiTestMocks.slack.conversations.replies,
        },
        files: {
          info: apiTestMocks.slack.files.info,
          getUploadURLExternal: apiTestMocks.slack.files.getUploadURLExternal,
          completeUploadExternal:
            apiTestMocks.slack.files.completeUploadExternal,
        },
        oauth: {
          v2: {
            access: apiTestMocks.slack.oauth.v2.access,
          },
        },
        views: {
          publish: apiTestMocks.slack.views.publish,
          open: apiTestMocks.slack.views.open,
        },
        users: {
          info: apiTestMocks.slack.users.info,
        },
      };
    }),
  };
});

vi.mock("../signals/external/slack-file-fetcher", async () => {
  const actual = await vi.importActual<
    typeof import("../signals/external/slack-file-fetcher")
  >("../signals/external/slack-file-fetcher");
  return {
    ...actual,
    fetchSlackFile: apiTestMocks.slack.fetchFile,
  };
});

vi.mock("../signals/external/telegram-client", async () => {
  const actual = await vi.importActual<
    typeof import("../signals/external/telegram-client")
  >("../signals/external/telegram-client");
  return {
    ...actual,
    getMe: apiTestMocks.telegram.getMe,
    getFile: apiTestMocks.telegram.getFile,
    deleteWebhook: apiTestMocks.telegram.deleteWebhook,
    setWebhook: apiTestMocks.telegram.setWebhook,
    setMyCommands: apiTestMocks.telegram.setMyCommands,
    getUserProfilePhotos: apiTestMocks.telegram.getUserProfilePhotos,
  };
});

vi.mock("../signals/external/axiom", () => {
  return {
    // Wrap the underlying vi.fn() in a ccstate `computed` so `get(queryAxiom(apl))`
    // resolves correctly. Tests configure responses via
    // `context.mocks.axiom.query.mockResolvedValue(...)`. The optional
    // `options` second arg is forwarded so tests can assert on `noCache`
    // (and any future option) via `expect(...).toHaveBeenCalledWith(apl, opts)`.
    queryAxiom: (apl: string, options?: unknown) => {
      return computed(() => {
        return apiTestMocks.axiom.query(apl, options);
      });
    },
    queryAxiomDirect: (apl: string, options?: unknown) => {
      return apiTestMocks.axiom.query(apl, options);
    },
    getDatasetName: (name: string) => {
      return name;
    },
    ingestToAxiom: (
      dataset: string,
      events: readonly Record<string, unknown>[],
    ) => {
      return apiTestMocks.axiom.ingest(dataset, events);
    },
    flushAxiom: (options?: unknown) => {
      return apiTestMocks.axiom.flush(options);
    },
  };
});

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: vi.fn(function () {
      return {
        flush: apiTestMocks.axiom.flush,
        ingest: apiTestMocks.axiom.sdkIngest,
        query: apiTestMocks.axiom.query,
      };
    }),
  };
});

vi.mock("@axiomhq/logging", () => {
  return {
    EVENT: Symbol("EVENT"),
    Logger: vi.fn(function () {
      return {
        debug: apiTestMocks.axiomLogging.debug,
        info: apiTestMocks.axiomLogging.info,
        warn: apiTestMocks.axiomLogging.warn,
        error: apiTestMocks.axiomLogging.error,
        flush: apiTestMocks.axiomLogging.flush,
      };
    }),
    AxiomJSTransport: vi.fn(function () {
      return {};
    }),
  };
});

export function getApiTestMocks(): ApiTestMocks {
  return apiTestMocks;
}

export function resetApiTestMocks(): void {
  apiTestMocks.ably.publish.mockReset();
  apiTestMocks.ably.publish.mockResolvedValue(undefined);
  apiTestMocks.ably.createTokenRequest.mockReset();
  apiTestMocks.axiom.flush.mockReset();
  apiTestMocks.axiom.ingest.mockReset();
  apiTestMocks.axiom.ingest.mockReturnValue(true);
  apiTestMocks.axiom.query.mockReset();
  apiTestMocks.axiom.sdkIngest.mockReset();
  apiTestMocks.axiomLogging.debug.mockReset();
  apiTestMocks.axiomLogging.info.mockReset();
  apiTestMocks.axiomLogging.warn.mockReset();
  apiTestMocks.axiomLogging.error.mockReset();
  apiTestMocks.axiomLogging.flush.mockReset();
  apiTestMocks.clerk.authenticateRequest.mockReset();
  apiTestMocks.clerk.verifyWebhook.mockReset();
  apiTestMocks.clerk.organizations.createOrganizationInvitation.mockReset();
  apiTestMocks.clerk.organizations.getOrganization.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationInvitationList.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationMembershipList.mockReset();
  apiTestMocks.clerk.organizations.deleteOrganizationLogo.mockReset();
  apiTestMocks.clerk.organizations.deleteOrganizationMembership.mockReset();
  apiTestMocks.clerk.organizations.revokeOrganizationInvitation.mockReset();
  apiTestMocks.clerk.organizations.deleteOrganization.mockReset();
  apiTestMocks.clerk.organizations.updateOrganization.mockReset();
  apiTestMocks.clerk.organizations.updateOrganizationMembership.mockReset();
  apiTestMocks.clerk.organizations.updateOrganizationLogo.mockReset();
  apiTestMocks.clerk.users.getUserList.mockReset();
  apiTestMocks.clerk.users.getOrganizationMembershipList.mockReset();
  apiTestMocks.clerk.users.updateUser.mockReset();
  apiTestMocks.clerk.signInTokens.createSignInToken.mockReset();
  apiTestMocks.s3.send.mockReset();
  apiTestMocks.s3.getSignedUrl.mockReset();
  apiTestMocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/upload?sig=test",
  );
  apiTestMocks.s3.clientConfig.mockReset();
  apiTestMocks.resend.send.mockReset();
  apiTestMocks.resend.get.mockReset();
  apiTestMocks.resend.receivingGet.mockReset();
  apiTestMocks.resend.attachmentsList.mockReset();
  apiTestMocks.slack.assistant.threads.setStatus.mockReset();
  apiTestMocks.slack.chat.postMessage.mockReset();
  apiTestMocks.slack.chat.postEphemeral.mockReset();
  apiTestMocks.slack.conversations.list.mockReset();
  apiTestMocks.slack.conversations.open.mockReset();
  apiTestMocks.slack.conversations.history.mockReset();
  apiTestMocks.slack.conversations.replies.mockReset();
  apiTestMocks.slack.files.info.mockReset();
  apiTestMocks.slack.files.getUploadURLExternal.mockReset();
  apiTestMocks.slack.files.completeUploadExternal.mockReset();
  apiTestMocks.slack.oauth.v2.access.mockReset();
  apiTestMocks.slack.views.publish.mockReset();
  apiTestMocks.slack.views.open.mockReset();
  apiTestMocks.slack.users.info.mockReset();
  apiTestMocks.slack.fetchFile.mockReset();
  apiTestMocks.stripe.invoices.list.mockReset();
  apiTestMocks.stripe.invoices.create.mockReset();
  apiTestMocks.stripe.invoices.finalizeInvoice.mockReset();
  apiTestMocks.stripe.invoices.pay.mockReset();
  apiTestMocks.stripe.invoiceItems.create.mockReset();
  apiTestMocks.stripe.customers.retrieve.mockReset();
  apiTestMocks.stripe.customers.create.mockReset();
  apiTestMocks.stripe.subscriptions.list.mockReset();
  apiTestMocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
  apiTestMocks.stripe.subscriptions.retrieve.mockReset();
  apiTestMocks.stripe.subscriptions.update.mockReset();
  apiTestMocks.stripe.subscriptions.cancel.mockReset();
  apiTestMocks.stripe.subscriptionSchedules.create.mockReset();
  apiTestMocks.stripe.subscriptionSchedules.update.mockReset();
  apiTestMocks.stripe.subscriptionSchedules.release.mockReset();
  apiTestMocks.stripe.webhooks.constructEvent.mockReset();
  apiTestMocks.stripe.checkout.sessions.create.mockReset();
  apiTestMocks.stripe.checkout.sessions.retrieve.mockReset();
  apiTestMocks.stripe.checkout.sessions.expire.mockReset();
  apiTestMocks.stripe.billingPortal.sessions.create.mockReset();
  apiTestMocks.stripe.coupons.retrieve.mockReset();
  apiTestMocks.stripe.prices.retrieve.mockReset();
  apiTestMocks.stripe.prices.create.mockReset();
  apiTestMocks.webpush.sendNotification.mockReset();
  apiTestMocks.webpush.sendNotification.mockResolvedValue(undefined);
  apiTestMocks.webpush.setVapidDetails.mockReset();
  // Re-install the Stripe client override so getStripeClient() returns
  // the centralized mock surface (the vi.mock("stripe") factory above
  // doesn't compose with `new StripeSDK()` because vi.fn isn't a real
  // constructor; we route through the testOverride instead).
  mockStripeClient(apiTestMocks.stripe as unknown as StripeSDK);
  apiTestMocks.telegram.getMe.mockReset();
  apiTestMocks.telegram.getFile.mockReset();
  apiTestMocks.telegram.deleteWebhook.mockReset();
  apiTestMocks.telegram.deleteWebhook.mockResolvedValue(undefined);
  apiTestMocks.telegram.setWebhook.mockReset();
  apiTestMocks.telegram.setWebhook.mockResolvedValue(undefined);
  apiTestMocks.telegram.setMyCommands.mockReset();
  apiTestMocks.telegram.setMyCommands.mockResolvedValue(undefined);
  apiTestMocks.telegram.getUserProfilePhotos.mockReset();
  apiTestMocks.otel.registerOTel.mockReset();
  apiTestMocks.sentry.captureException.mockReset();
  apiTestMocks.sentry.httpIntegration.mockClear();
  apiTestMocks.sentry.init.mockReset();
  apiTestMocks.sentry.nativeNodeFetchIntegration.mockClear();
}
