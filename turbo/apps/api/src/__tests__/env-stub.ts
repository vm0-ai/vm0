import { vi } from "vitest";

vi.stubEnv("CLERK_SECRET_KEY", "sk_test_dummy_for_unit_tests");
vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk_test_dummy_for_unit_tests");
vi.stubEnv(
  "SECRETS_ENCRYPTION_KEY",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
vi.stubEnv(
  "OFFICIAL_RUNNER_SECRET",
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
);
