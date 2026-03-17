/**
 * Tests for org model-provider command group structure
 */

import { describe, it, expect } from "vitest";
import { modelProviderCommand } from "..";

describe("org model-provider command group", () => {
  it("should have correct subcommands", () => {
    const subcommands = modelProviderCommand.commands.map((c) => c.name());
    expect(subcommands).toContain("list");
    expect(subcommands).toContain("setup");
    expect(subcommands).toContain("remove");
    expect(subcommands).toContain("set-default");
    expect(subcommands).toHaveLength(4);
  });
});
