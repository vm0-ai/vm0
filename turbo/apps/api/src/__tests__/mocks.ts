import { vi, type Mock } from "vitest";

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type SyncMock = Mock<(...args: unknown[]) => void>;

export interface ApiTestMocks {
  readonly clerk: {
    readonly authenticateRequest: AsyncMock;
    readonly users: {
      readonly getUserList: AsyncMock;
      readonly getOrganizationMembershipList: AsyncMock;
    };
  };
  readonly s3: {
    readonly send: AsyncMock;
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
  const clerk = {
    authenticateRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    users: {
      getUserList: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  };

  return {
    clerk,
    s3: {
      send: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
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

export function getApiTestMocks(): ApiTestMocks {
  return apiTestMocks;
}

export function resetApiTestMocks(): void {
  apiTestMocks.clerk.authenticateRequest.mockReset();
  apiTestMocks.clerk.users.getUserList.mockReset();
  apiTestMocks.clerk.users.getOrganizationMembershipList.mockReset();
  apiTestMocks.s3.send.mockReset();
  apiTestMocks.otel.registerOTel.mockReset();
  apiTestMocks.sentry.captureException.mockReset();
  apiTestMocks.sentry.httpIntegration.mockClear();
  apiTestMocks.sentry.init.mockReset();
  apiTestMocks.sentry.nativeNodeFetchIntegration.mockClear();
}
