import { readFile } from "node:fs/promises";

import {
  renderGeneratedMod,
  renderRustConstants,
  renderRustRoutes,
  renderRustTypes,
} from "../generate";
import { rustConstantBindings } from "../constants";
import { rustRouteBindings } from "../routes";
import { rustTypeBindings } from "../types";

const generatedDirectory = new URL(
  "../../../../../../crates/api-contracts/src/generated/",
  import.meta.url,
);

const generatedFiles = [
  {
    filename: "constants.rs",
    render: () => {
      return renderRustConstants(rustConstantBindings);
    },
  },
  {
    filename: "routes.rs",
    render: () => {
      return renderRustRoutes(rustRouteBindings);
    },
  },
  {
    filename: "types.rs",
    render: () => {
      return renderRustTypes(rustTypeBindings);
    },
  },
  {
    filename: "mod.rs",
    render: renderGeneratedMod,
  },
] as const;

describe("generated Rust API contracts", () => {
  it.each(generatedFiles)(
    "keeps committed $filename synchronized with the TypeScript registry",
    async ({ filename, render }) => {
      const committed = await readFile(
        new URL(filename, generatedDirectory),
        "utf8",
      );

      expect(committed).toBe(render());
    },
  );
});
