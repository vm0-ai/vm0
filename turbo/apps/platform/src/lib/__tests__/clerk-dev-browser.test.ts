import { describe, expect, it } from "vitest";

import {
  readClerkDevBrowserJwt,
  withClerkDevBrowserJwt,
} from "../clerk-dev-browser.ts";

describe("clerk dev browser", () => {
  it("prefers the instance-suffixed dev browser cookie", () => {
    expect(
      readClerkDevBrowserJwt(
        "__client_uat=1; __clerk_db_jwt=legacy; __clerk_db_jwt_MGaxFrJr=current",
      ),
    ).toBe("current");
  });

  it("falls back to the unsuffixed dev browser cookie", () => {
    expect(
      readClerkDevBrowserJwt("__client_uat=1; __clerk_db_jwt=legacy"),
    ).toBe("legacy");
  });

  it("reports no dev browser JWT for a production cookie header", () => {
    expect(
      readClerkDevBrowserJwt("__client_uat=1; __session=token"),
    ).toBeNull();
  });

  it("carries the dev browser JWT in the Frontend API query", () => {
    expect(
      withClerkDevBrowserJwt(
        new URL("https://informed-calf-6.clerk.accounts.dev/v1/client?a=1"),
        "dev-browser-jwt",
      ).toString(),
    ).toBe(
      "https://informed-calf-6.clerk.accounts.dev/v1/client?a=1&__clerk_db_jwt=dev-browser-jwt",
    );
  });
});
