import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tabs, TabsList, TabsTrigger } from "../tabs";

describe("Tabs", () => {
  it("uses the dedicated segment track token", () => {
    render(
      <Tabs defaultValue="activity">
        <TabsList aria-label="Activity sections">
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="context">Context</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    expect(
      screen.getByRole("tablist", { name: "Activity sections" }),
    ).toHaveClass("bg-segment-track");
  });
});
