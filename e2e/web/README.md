# Web E2E Tests

End-to-end tests for the VM0 web application using Playwright.

## Setup

Install dependencies:

```bash
cd e2e/web
npm install
npx playwright install chromium
```

## Running Tests Locally

Create a `.env.local` file with the base URL:

```bash
BASE_URL=http://localhost:3000
```

Then run the tests:

```bash
npm test
```

## Running Tests in CI

The tests are automatically run in GitHub Actions when a PR is created. The workflow:

1. Deploys the web app to a preview URL on Vercel
2. Waits for the deployment to be ready by checking the health endpoint
3. Passes the preview URL as `BASE_URL` environment variable
4. Runs the Playwright tests against the preview deployment

## Writing Tests

Tests are located in the `tests/` directory. Each test file should follow the pattern `*.spec.ts`.

Example test:

```typescript
import { test, expect } from "@playwright/test";

test("homepage loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/VM0/i);
});
```

The `baseURL` is configured in `playwright.config.ts` from the `BASE_URL` environment variable, so tests can use relative paths like `page.goto("/")`.
