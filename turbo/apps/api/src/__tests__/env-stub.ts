import { vi } from "vitest";

if (!process.env.DATABASE_URL) {
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/vm0_test",
  );
}
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
vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
vi.stubEnv("FAL_KEY", "test-fal-key");
vi.stubEnv("CRON_SECRET", "test-cron-secret");
vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
vi.stubEnv("R2_ACCOUNT_ID", "test-account");
vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-user-storages");
vi.stubEnv("VM0_API_URL", "http://localhost:3000");
vi.stubEnv("VM0_WEB_URL", "http://localhost:3001");
vi.stubEnv("APP_URL", "http://localhost:3002");
vi.stubEnv("RESEND_FROM_DOMAIN", "mail.example.com");
vi.stubEnv("GIT_COMMIT_SHA", "test-commit-sha");
vi.stubEnv("ENV", "development");
vi.stubEnv("AXIOM_TOKEN_SESSIONS", "xaat-test-sessions");
vi.stubEnv("AXIOM_TOKEN_TELEMETRY", "xaat-test-telemetry");
vi.stubEnv("AXIOM_DATASET_SUFFIX", "dev");
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_for_unit_tests");
vi.stubEnv("ABLY_API_KEY", "test-ably-key");
