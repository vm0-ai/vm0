import type {
  TestArtifactPreviewStateActionBody,
  TestArtifactPreviewStateActionResponse,
} from "@vm0/api-contracts/contracts/test-artifact-preview-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testArtifactPreviewStateRoutes } from "../../test-artifact-preview-state";

const ARTIFACT_PREVIEW_STATE_ROUTE = "/api/test/artifact-preview-state/action";

function requestArtifactPreviewState(
  context: TestContext,
  body: TestArtifactPreviewStateActionBody,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testArtifactPreviewStateRoutes,
  });
  return Promise.resolve(
    app.request(ARTIFACT_PREVIEW_STATE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function postArtifactPreviewState(
  context: TestContext,
  body: TestArtifactPreviewStateActionBody,
): Promise<TestArtifactPreviewStateActionResponse> {
  const response = await requestArtifactPreviewState(context, body);
  if (!response.ok) {
    throw new Error(
      `artifact preview state action failed with ${response.status}`,
    );
  }
  return (await response.json()) as TestArtifactPreviewStateActionResponse;
}

export async function markHostedArtifactEligibleForPreviewCron(
  context: TestContext,
  artifact: {
    readonly runId: string;
    readonly url: string;
  },
  options: { readonly generatedBy?: string } = {},
): Promise<void> {
  const body = await postArtifactPreviewState(context, {
    action: "mark-preview-cron-eligible",
    run_id: artifact.runId,
    url: artifact.url,
    ...(options.generatedBy ? { generated_by: options.generatedBy } : {}),
  });
  if (body.updated !== 1) {
    throw new Error(
      `Expected one artifact preview state row update, received ${body.updated ?? 0}`,
    );
  }
}
