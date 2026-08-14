# Browser PPTX renderer fixtures

These fixtures are generated documents, not third-party presentations:

- `supported.pptx`: three 16:9 slides covering Latin and CJK fonts, mixed text,
  common and grouped shapes, gradients, an embedded PNG, a merged table, and a
  clustered column chart.
- `unsupported-ole.pptx`: one slide with an embedded Excel OLE package and WMF
  icon, used to verify the explicit unsupported-content boundary.
- `too-many-pages.pptx`: 101 blank slides, used to verify the 100-page limit.

The files were generated with `python-pptx` 1.0.2. They contain no private or
copyrighted source material.
