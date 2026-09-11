import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createProjectionObservationFixture } from "./helpers/projection-observations";

const context = testContext();

// This isolated module owns one process-local observation history.
// Independent scenarios use separate modules, without a shared cache reset.
test("observes projection reuse at distance four without changing the run selection cache", async () => {
  expect.hasAssertions();
  const createObservedRun = await createProjectionObservationFixture(context);
  await createObservedRun(0, "first_observation");
  for (let scope = 1; scope < 4; scope++) {
    await createObservedRun(scope, "not_in_recent_history");
  }
  await createObservedRun(0, "reuse_3_4");
});
