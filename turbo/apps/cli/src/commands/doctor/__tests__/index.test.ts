import { describe, expect, it } from "vitest";

import { doctorCommand } from "../index";

describe("okou doctor command", () => {
  it("documents the aggregate connector doctor without changing connector check", () => {
    let help = "";
    doctorCommand.configureOutput({
      writeOut: (text: string) => {
        help += text;
      },
    });
    doctorCommand.outputHelp();
    const normalizedHelp = help.replace(/\s+/gu, " ");

    expect(normalizedHelp).toContain("connectors [options] [workflow]");
    expect(normalizedHelp).toContain(
      "Diagnose stored connector readiness across workflows",
    );
    expect(normalizedHelp).toContain(
      "stored connector readiness across effective visible workflows on every visible Agent",
    );
    expect(normalizedHelp).toContain(
      "Use okou connector check for one current-run URL, environment name, firewall decision, or permission failure",
    );
  });
});
