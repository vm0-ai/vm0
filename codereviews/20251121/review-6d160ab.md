# Review: perf: optimize landing page background images

**Commit:** 6d160ab3540e063856144dfbec80578920eaefda
**Author:** Ethan Zhang
**Date:** Fri Nov 21 23:04:00 2025 +0800

## Summary

Optimized landing page background images by converting PNG files to modern formats (WebP/AVIF) using the sharp library:

- Added image conversion script (convert-images.ts) using sharp
- Generated WebP and AVIF versions of bg_1.png, bg_2.png, and bg_4.png
- Updated CSS to use CSS image-set() with format fallbacks
- Achieved 98.8% reduction in total image size (2.5MB to 32KB)
- Maintained backward compatibility with PNG fallback for legacy browsers

## Code Smell Analysis

### ✅ Good Practices

- Excellent performance optimization with measurable metrics (98.8% reduction)
- Proper progressive enhancement with format fallbacks (AVIF → WebP → PNG)
- Browser compatibility handled gracefully via CSS image-set()
- Clear, well-documented conversion script with console output
- Sharp library choice is appropriate for image processing
- Added sharp to dependencies correctly via package.json
- CSS changes maintain visual fidelity while reducing file size

### ⚠️ Issues Found

- **None identified** - The implementation follows best practices for modern image optimization

### 💡 Recommendations

- Consider automating the image conversion script to run in build pipeline rather than manual execution
- Document the conversion script's usage in project README or setup instructions
- Monitor real-world browser usage to ensure AVIF/WebP fallback chains work as expected
- Consider applying similar optimization to other PNG/image assets across the site

## Breaking Changes

- **None** - Fully backward compatible with CSS fallback chain supporting all browsers
- PNG originals remain as fallback, ensuring no functionality loss
