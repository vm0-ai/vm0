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
vi.stubEnv("BYTEPLUS_API_KEY", "test-byteplus-key");
vi.stubEnv("CRON_SECRET", "test-cron-secret");
vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
vi.stubEnv("R2_ACCOUNT_ID", "test-account");
vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-user-storages");
vi.stubEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "test-user-artifacts");
vi.stubEnv("R2_USER_ARTIFACTS_ACCESS_KEY_ID", "test-artifacts-access-key");
vi.stubEnv("R2_USER_ARTIFACTS_SECRET_ACCESS_KEY", "test-artifacts-secret-key");
vi.stubEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm7.io");
vi.stubEnv("R2_HOSTED_SITES_BUCKET_NAME", "test-hosted-sites");
vi.stubEnv("R2_HOSTED_SITES_ACCESS_KEY_ID", "test-hosted-sites-access-key");
vi.stubEnv("R2_HOSTED_SITES_SECRET_ACCESS_KEY", "test-hosted-sites-secret-key");
vi.stubEnv("ZERO_HOST_DOMAIN", "sites.example.com");
vi.stubEnv("ZERO_HOST_SCHEME", "https");
vi.stubEnv("VM0_API_URL", "http://localhost:3000");
vi.stubEnv("VM0_WEB_URL", "http://localhost:3001");
vi.stubEnv("APP_URL", "http://localhost:3002");
vi.stubEnv("RESEND_API_KEY", "test-resend-key");
vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
vi.stubEnv("RESEND_FROM_DOMAIN", "mail.example.com");
vi.stubEnv("GIT_COMMIT_SHA", "test-commit-sha");
vi.stubEnv("ENV", "development");
vi.stubEnv("AXIOM_TOKEN_SESSIONS", "xaat-test-sessions");
vi.stubEnv("AXIOM_TOKEN_TELEMETRY", "xaat-test-telemetry");
vi.stubEnv("AXIOM_DATASET_SUFFIX", "dev");
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_for_unit_tests");
vi.stubEnv("ABLY_API_KEY", "test-ably-key");
