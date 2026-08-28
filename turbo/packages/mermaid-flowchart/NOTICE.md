# Mermaid attribution and modifications

This package contains a modified build of
[Mermaid](https://github.com/mermaid-js/mermaid) 11.16.1, upstream commit
`7ecca0cd7f1658ef74f4e7e91f925724ef403bbf`.

Mermaid is Copyright (c) 2014-2022 Knut Sveidqvist and is distributed under
the MIT License in [LICENSE](./LICENSE).

vm0's build makes these functional changes:

- registers only Mermaid's `flowchart` and legacy `graph` syntaxes;
- retains only the Dagre layout loader;
- statically links the Flowchart parser and Dagre renderer into one ESM file;
- excludes the other diagram detectors, ELK/Cytoscape layouts, and
  diagram-specific KaTeX code from the generated module graph; and
- exposes only the Mermaid API surface used by the vm0 platform.

The generated files retain the bundled third-party license comments emitted
by Mermaid's upstream esbuild configuration. This package is not affiliated
with or endorsed by the Mermaid project.
