import { computed } from "ccstate";
import { vi, type Mock } from "vitest";

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
  readonly clerk: {
    readonly authenticateRequest: AsyncMock;
    readonly organizations: {
      readonly getOrganization: AsyncMock;
      readonly getOrganizationDomainList: AsyncMock;
      readonly getOrganizationInvitationList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
    };
    readonly users: {
      readonly getUserList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
    };
  };
  readonly s3: {
    readonly send: AsyncMock;
  };
  readonly slack: {
    readonly conversations: {
      readonly list: AsyncMock;
    };
    readonly files: {
      readonly info: AsyncMock;
    };
    readonly fetchFile: AsyncMock;
  };
  readonly stripe: {
    readonly invoices: {
      readonly list: AsyncMock;
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
      getOrganization: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationDomainList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationInvitationList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    users: {
      getUserList: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  };

  const slack = {
    conversations: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    files: {
      info: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
    fetchFile: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };

  const stripe = {
    invoices: {
      list: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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
    axiom,
    axiomLogging,
    clerk,
    s3: {
      send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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

  class S3Client {
    send(command: unknown): Promise<unknown> {
      return apiTestMocks.s3.send(command);
    }
  }

  return {
    GetObjectCommand,
    ListObjectsV2Command,
    S3Client,
  };
});

vi.mock("@clerk/backend", () => {
  return {
    createClerkClient: () => {
      return apiTestMocks.clerk;
    },
  };
});

vi.mock("@sentry/node", () => {
  return apiTestMocks.sentry;
});

vi.mock("@vercel/otel", () => {
  return apiTestMocks.otel;
});

vi.mock("stripe", () => {
  return {
    default: vi.fn(() => {
      return {
        invoices: {
          list: apiTestMocks.stripe.invoices.list,
        },
      };
    }),
  };
});

vi.mock("@slack/web-api", () => {
  return {
    WebClient: vi.fn(() => {
      return {
        conversations: {
          list: apiTestMocks.slack.conversations.list,
        },
        files: {
          info: apiTestMocks.slack.files.info,
        },
      };
    }),
  };
});

vi.mock("../signals/external/slack-file-fetcher", () => {
  return {
    fetchSlackFile: apiTestMocks.slack.fetchFile,
  };
});

vi.mock("../signals/external/telegram-client", () => {
  return {
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
  apiTestMocks.axiom.query.mockReset();
  apiTestMocks.axiomLogging.debug.mockReset();
  apiTestMocks.axiomLogging.info.mockReset();
  apiTestMocks.axiomLogging.warn.mockReset();
  apiTestMocks.axiomLogging.error.mockReset();
  apiTestMocks.axiomLogging.flush.mockReset();
  apiTestMocks.clerk.authenticateRequest.mockReset();
  apiTestMocks.clerk.organizations.getOrganization.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationDomainList.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationInvitationList.mockReset();
  apiTestMocks.clerk.organizations.getOrganizationMembershipList.mockReset();
  apiTestMocks.clerk.users.getUserList.mockReset();
  apiTestMocks.clerk.users.getOrganizationMembershipList.mockReset();
  apiTestMocks.s3.send.mockReset();
  apiTestMocks.slack.conversations.list.mockReset();
  apiTestMocks.slack.files.info.mockReset();
  apiTestMocks.slack.fetchFile.mockReset();
  apiTestMocks.stripe.invoices.list.mockReset();
  apiTestMocks.telegram.getMe.mockReset();
  apiTestMocks.telegram.getFile.mockReset();
  apiTestMocks.otel.registerOTel.mockReset();
  apiTestMocks.sentry.captureException.mockReset();
  apiTestMocks.sentry.httpIntegration.mockClear();
  apiTestMocks.sentry.init.mockReset();
  apiTestMocks.sentry.nativeNodeFetchIntegration.mockClear();
}
