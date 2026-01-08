import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Mock Clerk (client-side version)
vi.mock("@clerk/clerk-js", () => ({
  Clerk: vi.fn(() => ({
    load: vi.fn(),
    user: null,
    openSignIn: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
  })),
}));
