import { describe, expect, it } from "vitest";
import { program } from "../../../../index";
import { registerZeroCommands } from "../../../../zero";
import { Command } from "commander";

describe("remote-agent command registration", () => {
  it("registers under vm0", () => {
    const remoteAgent = program.commands.find((command) => {
      return command.name() === "remote-agent";
    });
    expect(remoteAgent).toBeDefined();

    const subNames = remoteAgent!.commands.map((command) => {
      return command.name();
    });
    expect(subNames).toContain("start");
    expect(subNames).toContain("list");
    expect(subNames).toContain("delete");
    expect(subNames).toContain("run");
    expect(subNames).toContain("runs");
    expect(subNames).not.toContain("connect");
    expect(subNames).not.toContain("host");
    expect(subNames).not.toContain("kill");
  });

  it("registers list and run under zero", () => {
    const prog = new Command();
    registerZeroCommands(prog);

    const remoteAgent = prog.commands.find((command) => {
      return command.name() === "remote-agent";
    });
    expect(remoteAgent).toBeDefined();

    const subNames = remoteAgent!.commands.map((command) => {
      return command.name();
    });
    expect(subNames).toContain("list");
    expect(subNames).toContain("run");
    expect(subNames).toContain("runs");
    expect(subNames).not.toContain("start");
    expect(subNames).not.toContain("delete");
    expect(subNames).not.toContain("connect");
  });
});
