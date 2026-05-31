"use client";

import { useEffect } from "react";
import {
  currentLandingAttributionContext,
  decorateAttributionHref,
} from "../../src/lib/adAttribution";
import { getAppUrl } from "../../src/lib/zero/url";

function closestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element
    ? target.closest<HTMLAnchorElement>("a[href]")
    : null;
}

export function AttributionLinkDecorator() {
  useEffect(() => {
    const appUrl = getAppUrl();

    const decorateAnchor = (anchor: HTMLAnchorElement): void => {
      const nextHref = decorateAttributionHref(
        anchor.getAttribute("href") ?? anchor.href,
        appUrl,
        window.location.search,
        currentLandingAttributionContext(),
      );
      if (
        nextHref !== anchor.href &&
        nextHref !== anchor.getAttribute("href")
      ) {
        anchor.href = nextHref;
      }
    };

    const decorateAllAnchors = (): void => {
      document
        .querySelectorAll<HTMLAnchorElement>("a[href]")
        .forEach(decorateAnchor);
    };

    const handleClick = (event: MouseEvent): void => {
      const anchor = closestAnchor(event.target);
      if (anchor) {
        decorateAnchor(anchor);
      }
    };

    decorateAllAnchors();
    document.addEventListener("click", handleClick, true);
    const observer = new MutationObserver(decorateAllAnchors);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["href"],
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  return null;
}
