import { vi } from "vitest";

let internalMockedUser: { id: string; fullName: string } | null = null;
let internalMockedSession: { token: string } | null = null;

export function mockUser(
  user: { id: string; fullName: string } | null,
  session: { token: string } | null,
) {
  internalMockedUser = user;
  internalMockedSession = session;
}

export function clearMockedAuth() {
  internalMockedUser = null;
  internalMockedSession = null;
}

export const mockedClerk = {
  get user() {
    return internalMockedUser;
  },
  get session() {
    return {
      getToken: () => Promise.resolve(internalMockedSession?.token ?? ""),
    };
  },
  load: () => Promise.resolve(),
  addListener: () => () => {},
  redirectToSignIn: vi.fn(),
};
