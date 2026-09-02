import { useEffect, useLayoutEffect, useState } from "react";

interface UseMediaQueryOptions {
  /** Value returned during server rendering. */
  readonly defaultValue?: boolean;
  /** Read the media query for the initial client render. */
  readonly initializeWithValue?: boolean;
}

const IS_SERVER = typeof window === "undefined";
const useIsomorphicLayoutEffect = IS_SERVER ? useEffect : useLayoutEffect;

/** Track whether a CSS media query currently matches. */
export function useMediaQuery(
  query: string,
  {
    defaultValue = false,
    initializeWithValue = true,
  }: UseMediaQueryOptions = {},
): boolean {
  const getMatches = (): boolean => {
    if (IS_SERVER) {
      return defaultValue;
    }
    return window.matchMedia(query).matches;
  };

  const [matches, setMatches] = useState<boolean>(() => {
    return initializeWithValue ? getMatches() : defaultValue;
  });

  useIsomorphicLayoutEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    const handleChange = (): void => {
      setMatches(mediaQueryList.matches);
    };

    handleChange();

    mediaQueryList.addEventListener("change", handleChange);
    return () => {
      mediaQueryList.removeEventListener("change", handleChange);
    };
  }, [query]);

  return matches;
}
