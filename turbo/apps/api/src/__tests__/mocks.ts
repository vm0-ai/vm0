import type StripeSDK from "stripe";
import { computed } from "ccstate";
import { vi, type Mock } from "vitest";

import { mockStripeClient } from "../signals/external/stripe-client";

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type SyncMock = Mock<(...args: unknown[]) => void>;

export interface ApiTestMocks {
  readonly axiom: {
    readonly query: AsyncMock;
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
  };
  readonly clerk: {
    readonly authenticateRequest: AsyncMock;
    readonly organizations: {
      readonly createOrganizationInvitation: AsyncMock;
      readonly getOrganization: AsyncMock;
      readonly getOrganizationDomainList: AsyncMock;
      readonly getOrganizationInvitationList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
      readonly revokeOrganizationInvitation: AsyncMock;
    };
    readonly users: {
      readonly getUserList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
    };
  };
  readonly s3: {
    readonly send: AsyncMock;
    readonly getSignedUrl: AsyncMock;
    readonly clientConfig: SyncMock;
  };
  readonly slack: {
    readonly chat: {
      readonly postMessage: AsyncMock;
      readonly postEphemeral: AsyncMock;
    };
    readonly conversations: {
      readonly list: AsyncMock;
      readonly open: AsyncMock;
    };
    readonly files: {
      readonly info: AsyncMock;
      readonly getUploadURLExternal: AsyncMock;
      readonly completeUploadExternal: AsyncMock;
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
      readonly retrieve: AsyncMock;
      readonly update: AsyncMock;
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
    };
  };
  readonly telegram: {
    readonly getMe: AsyncMock;
    readonly getFile: AsyncMock;
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
    query: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  const clerk = {
    authenticateRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    organizations: {
      createOrganizationInvitation:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganization: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationDomainList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationInvitationList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      revokeOrganizationInvitation:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    users: {
      getUserList: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  };

  const slack = {
    chat: {
      postMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      postEphemeral: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    conversations: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      open: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    files: {
      info: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getUploadURLExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      completeUploadExternal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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
      retrieve: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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
    },
  };

  const telegram = {
    getMe: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    getFile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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
    },
    axiom,
    axiomLogging,
    clerk,
    s3: {
      send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getSignedUrl: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      clientConfig: vi.fn<(...args: unknown[]) => void>(),
    },
    slack,
    stripe,
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

vi.mock("ably", () => {
  class MockRest {
    readonly channels = {
      get: () => {
        return { publish: apiTestMocks.ably.publish };
      },
    };
    readonly auth = { createTokenRequest: vi.fn() };
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
          retrieve: apiTestMocks.stripe.subscriptions.retrieve,
          update: apiTestMocks.stripe.subscriptions.update,
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
        chat: {
          postMessage: apiTestMocks.slack.chat.postMessage,
          postEphemeral: apiTestMocks.slack.chat.postEphemeral,
        },
        conversations: {
          list: apiTestMocks.slack.conversations.list,
          open: apiTestMocks.slack.conversations.open,
        },
        files: {
          info: apiTestMocks.slack.files.info,
          getUploadURLExternal: apiTestMocks.slack.files.getUploadURLExternal,
          completeUploadExternal:
            apiTestMocks.slack.files.completeUploadExternal,
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
  };
});

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: vi.fn(function () {
      return {};
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
  apiTestMocks.axiom.query.mockReset();
  apiTestMocks.axiomLogging.debug.mockReset();
  apiTestMocks.axiomLogging.info.mockReset();
  apiTestMocks.axiomLogging.warn.mockReset();
  apiTestMocks.axiomLogging.error.mockReset();
  apiTestMocks.axiomLogging.flush.mockReset();
  apiTestMocks.clerk.authenticateRequest.mockReset();
  apiTestMocks.clerk.organizations.createOrganizationInvitation.mockReset();
  apiTestMocks.clerk.organizations.getOrganization.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationDomainList.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationInvitationList.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationMembershipList.mockReset();
  apiTestMocks.clerk.organizations.revokeOrganizationInvitation.mockReset();
  apiTestMocks.clerk.users.getUserList.mockReset();
  apiTestMocks.clerk.users.getOrganizationMembershipList.mockReset();
  apiTestMocks.s3.send.mockReset();
  apiTestMocks.s3.getSignedUrl.mockReset();
  apiTestMocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/upload?sig=test",
  );
  apiTestMocks.s3.clientConfig.mockReset();
  apiTestMocks.slack.chat.postMessage.mockReset();
  apiTestMocks.slack.chat.postEphemeral.mockReset();
  apiTestMocks.slack.conversations.list.mockReset();
  apiTestMocks.slack.conversations.open.mockReset();
  apiTestMocks.slack.files.info.mockReset();
  apiTestMocks.slack.files.getUploadURLExternal.mockReset();
  apiTestMocks.slack.files.completeUploadExternal.mockReset();
  apiTestMocks.slack.fetchFile.mockReset();
  apiTestMocks.stripe.invoices.list.mockReset();
  apiTestMocks.stripe.invoices.create.mockReset();
  apiTestMocks.stripe.invoices.finalizeInvoice.mockReset();
  apiTestMocks.stripe.invoices.pay.mockReset();
  apiTestMocks.stripe.invoiceItems.create.mockReset();
  apiTestMocks.stripe.customers.retrieve.mockReset();
  apiTestMocks.stripe.customers.create.mockReset();
  apiTestMocks.stripe.subscriptions.retrieve.mockReset();
  apiTestMocks.stripe.subscriptions.update.mockReset();
  apiTestMocks.stripe.checkout.sessions.create.mockReset();
  apiTestMocks.stripe.checkout.sessions.retrieve.mockReset();
  apiTestMocks.stripe.checkout.sessions.expire.mockReset();
  apiTestMocks.stripe.billingPortal.sessions.create.mockReset();
  apiTestMocks.stripe.coupons.retrieve.mockReset();
  apiTestMocks.stripe.prices.retrieve.mockReset();
  // Re-install the Stripe client override so getStripeClient() returns
  // the centralized mock surface (the vi.mock("stripe") factory above
  // doesn't compose with `new StripeSDK()` because vi.fn isn't a real
  // constructor; we route through the testOverride instead).
  mockStripeClient(apiTestMocks.stripe as unknown as StripeSDK);
  apiTestMocks.telegram.getMe.mockReset();
  apiTestMocks.telegram.getFile.mockReset();
  apiTestMocks.otel.registerOTel.mockReset();
  apiTestMocks.sentry.captureException.mockReset();
  apiTestMocks.sentry.httpIntegration.mockClear();
  apiTestMocks.sentry.init.mockReset();
  apiTestMocks.sentry.nativeNodeFetchIntegration.mockClear();
}
