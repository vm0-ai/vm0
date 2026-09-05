# Desktop brand assets

The Okou source artwork comes from the canonical team Drive folder:
<https://drive.google.com/drive/folders/1Zn6tbmD_EhPYUOKMOJTptyp453zUZ234>.

- `src/renderer/assets/okou-symbol-light.svg` is sourced from `symbol-light-colorful.svg` (source SHA-256: `cb08ae74055d141d6850053d9036fa363ed110d5d5daf66032a0c594fb7555e2`).
- `src/renderer/assets/okou-wordmark-dark.svg` is sourced from `logo-dark.svg` (source SHA-256: `f52c45acee0ac36024126ebf50fe91315c8ca36745dd950bfeedc4210739b099`).
- `icon.svg` adapts the square Okou symbol to the macOS app-icon safe area.
- The tray SVGs adapt the transparent Okou symbol for online, disabled, and running states.
- The running tray PNGs are horizontal strips of 60 square, clockwise-rotated orange frames. Desktop plays them at 20 frames per second for a three-second rotation, with 18px and 36px frames for standard and Retina displays.

Regenerate `icon.png`, `icon.icns`, and the 1x/2x tray PNGs from their SVG sources with:

```bash
pnpm -F @okouai/desktop assets:generate
```

Files prefixed with `zero-` and `icon-zero.*` are retained for explicit legacy Zero builds.
