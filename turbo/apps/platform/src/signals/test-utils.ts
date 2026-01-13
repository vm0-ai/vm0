import { vi } from "vitest";

type Listener = () => void;

interface ClerkSession {
  getToken: () => Promise<string | null>;
}

interface ClerkUser {
  id: string;
  emailAddresses?: {
    emailAddress: string;
  }[];
  fullName?: string | null;
  username?: string | null;
  imageUrl?: string | null;
  [key: string]: unknown;
}

export class MockClerk {
  private readonly listeners: Listener[] = [];
  private static readonly instances = new Map<string, MockClerk>();

  user: ClerkUser | null = null;
  session: ClerkSession | null = null;

  constructor(public publishableKey: string) {
    // Reuse existing instance if it exists for this key
    const existing = MockClerk.instances.get(publishableKey);
    if (existing) {
      return existing;
    }
    // Store reference to current instance
    MockClerk.instances.set(publishableKey, this);
  }

  load() {
    return Promise.resolve();
  }

  openSignIn() {
    // Mock implementation - does nothing in tests
    return Promise.resolve();
  }

  addListener(callback: () => void): () => void {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  removeListener(callback: () => void): void {
    const index = this.listeners.indexOf(callback);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  setSession(session: ClerkSession | null) {
    this.session = session;
    this.notifyListeners();
  }

  setUser(user: ClerkUser | null) {
    this.user = user;
    this.notifyListeners();
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  static getInstance(): MockClerk | null {
    // Return the first instance (for test key)
    return MockClerk.instances.get("test_key") ?? null;
  }

  static resetInstance() {
    // Reset all instances
    for (const instance of MockClerk.instances.values()) {
      instance.user = null;
      instance.session = null;
      instance.listeners.length = 0;
    }
  }
}

export function setupMock() {
  vi.mock("@clerk/clerk-js", () => ({
    Clerk: MockClerk,
  }));
}

export function getMockClerk(): MockClerk | null {
  return MockClerk.getInstance();
}

export function resetMockAuth() {
  MockClerk.resetInstance();
}
