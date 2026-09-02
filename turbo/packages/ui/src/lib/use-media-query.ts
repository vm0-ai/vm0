import { useLayoutEffect, useState } from "react";

/** Track whether a CSS media query currently matches. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    return window.matchMedia(query).matches;
  });

  useLayoutEffect(() => {
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
