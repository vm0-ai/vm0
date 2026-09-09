# Shared selection controls

The settings and Tone runners together cover all three shared selection-control
consumers. Run both when changing the control or its common button styles:

| Runner | Consumers | Captured states |
| --- | --- | --- |
| `pnpm style:migration` | Appearance and Send mode | 21 |
| `pnpm style:migration:tone` | Agent profile Tone | 33 |

Follow [the migration protocol](../../../docs/style-migration.md) for deployment
identity, private authentication, fixtures, unchanged-code calibration and
immutable evidence. Tone's already-migrated control uses `--aria-mode pressed`
for both the baseline and replay. Keep the same runner, cases, fixture and
Chromium version throughout the comparison.

These production consumers have visible labels and do not enable tooltips.
Shared UI component tests separately exercise optional tooltips and their
disabled-trigger behavior; screenshots of these pages do not establish that
coverage. Group selection remains controlled by the page, including keeping
the active choice selected when it is activated again.
