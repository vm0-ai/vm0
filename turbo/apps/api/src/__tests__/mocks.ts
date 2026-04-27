import { vi, type Mock } from "vitest";

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type SyncMock = Mock<(...args: unknown[]) => void>;

export interface ApiTestMocks {
  readonly clerk: {
    readonly authenticateRequest: AsyncMock;
    readonly users: {
      readonly getOrganizationMembershipList: AsyncMock;
    };
  };
  readonly otel: {
    readonly registerOTel: SyncMock;
  };
  readonly sentry: {
    readonly captureException: SyncMock;
    readonly init: SyncMock;
  };
}

const apiTestMocks: ApiTestMocks = vi.hoisted((): ApiTestMocks => {
  const clerk = {
    authenticateRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    users: {
      getOrganizationMembershipList:
        vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  };

  return {
    clerk,
    otel: {
      registerOTel: vi.fn<(...args: unknown[]) => void>(),
    },
    sentry: {
      captureException: vi.fn<(...args: unknown[]) => void>(),
      init: vi.fn<(...args: unknown[]) => void>(),
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
  apiTestMocks.clerk.users.getOrganizationMembershipList.mockReset();
  apiTestMocks.otel.registerOTel.mockReset();
  apiTestMocks.sentry.captureException.mockReset();
  apiTestMocks.sentry.init.mockReset();
}
