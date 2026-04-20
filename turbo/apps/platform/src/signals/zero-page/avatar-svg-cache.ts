import { computed, type Computed } from "ccstate";
import {
  type AvatarSvgConfig,
  serializeAvatarSvgConfig,
  loadCompositeAvatarSvg,
} from "../../views/zero-page/avatar-svg-utils.ts";

function createCompositeAvatarAtomFactory(): (
  config: AvatarSvgConfig,
) => Computed<Promise<string>> {
  const cache = new Map<string, Computed<Promise<string>>>();
  return (config) => {
    const key = serializeAvatarSvgConfig(config);
    const existing = cache.get(key);
    if (existing) {
      return existing;
    }
    const atom$ = computed(() => {
      return loadCompositeAvatarSvg(config);
    });
    cache.set(key, atom$);
    return atom$;
  };
}

/**
 * Return a stable computed atom that lazily loads and combines the 3 SVG layers
 * for a given avatar config. The atom is cached per unique config string.
 */
export const compositeAvatarSvg$ = createCompositeAvatarAtomFactory();
