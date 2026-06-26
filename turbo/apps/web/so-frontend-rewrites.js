const LOCALES = ["en", "de", "ja", "es"];

const SO_FRONTEND_EXACT_PATHS = [
  "/",
  "/pricing",
  "/security",
  "/rankings",
  "/illustration",
  "/web-design",
  "/presentation",
  "/video",
  "/report",
  "/sprite",
  "/terms-of-use",
  "/privacy-policy",
  "/support",
  "/use-cases",
  "/models",
  "/blog",
  "/docs",
];

const SO_FRONTEND_WILDCARD_PATHS = [
  "/use-cases/:path*",
  "/models/:path*",
  "/blog/:path*",
  "/docs/:path*",
];

const SO_FRONTEND_DESTINATION_OVERRIDES = new Map([
  ["/", "/en"],
  ["/report", "/en/report"],
  ["/docs", "/en/docs"],
  ["/docs/:path*", "/en/docs/:path*"],
]);

const SO_FRONTEND_AUTH_PATHS = [
  "/sign-in",
  "/sign-in/:path*",
  "/sign-up",
  "/sign-up/:path*",
];

const SO_FRONTEND_FUNCTIONAL_PATHS = [
  "/cli-auth",
  "/cli-auth/:path*",
  "/connector/:path*",
  "/desktop-auth/:path*",
  "/export",
  "/sign-in-token",
  "/monday-app-association.json",
];

const SO_FRONTEND_ASSET_PATHS = [
  "/assets/:path*",
  "/images/:path*",
  "/favicon.ico",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/og-image.png",
  "/checkmark-primary.svg",
];

function authRewritePaths() {
  return SO_FRONTEND_AUTH_PATHS;
}

function withoutTrailingSlash(value) {
  return value.replace(/\/$/u, "");
}

export function resolveSoFrontendUrl(env) {
  const explicit =
    env.PAID_ONBOARDING_URL?.trim() ||
    env.NEXT_PUBLIC_PAID_ONBOARDING_URL?.trim();
  if (explicit) {
    return withoutTrailingSlash(explicit);
  }

  if (env.VERCEL_ENV === "production") {
    return "https://so.vm0.ai";
  }

  return undefined;
}

function exactRewrite(source, destinationPrefix) {
  const destinationPath =
    SO_FRONTEND_DESTINATION_OVERRIDES.get(source) ?? source;
  return {
    source,
    destination: `${destinationPrefix}${destinationPath}`,
  };
}

function localizedExactRewrite(locale, source, destinationPrefix) {
  return {
    source: `/${locale}${source === "/" ? "" : source}`,
    destination: `${destinationPrefix}/${locale}${source === "/" ? "" : source}`,
  };
}

function rewriteSourceMatchesPath(source, pathname) {
  const wildcardSuffix = "/:path*";
  if (!source.endsWith(wildcardSuffix)) {
    return source === pathname;
  }

  const prefix = source.slice(0, -wildcardSuffix.length);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function rewriteDestinationPath(source, destination, pathname) {
  const wildcardSuffix = "/:path*";
  if (!source.endsWith(wildcardSuffix)) {
    return destination;
  }

  const sourcePrefix = source.slice(0, -wildcardSuffix.length);
  const destinationPrefix = destination.slice(0, -wildcardSuffix.length);
  return `${destinationPrefix}${pathname.slice(sourcePrefix.length)}`;
}

function rewriteSourceDefinitions(env) {
  const localizedContentPaths = [
    ...SO_FRONTEND_EXACT_PATHS,
    ...SO_FRONTEND_WILDCARD_PATHS,
  ];

  return [
    ...SO_FRONTEND_EXACT_PATHS.map((source) => {
      return {
        source,
        destination: SO_FRONTEND_DESTINATION_OVERRIDES.get(source) ?? source,
      };
    }),
    ...SO_FRONTEND_WILDCARD_PATHS.map((source) => {
      return {
        source,
        destination: SO_FRONTEND_DESTINATION_OVERRIDES.get(source) ?? source,
      };
    }),
    ...LOCALES.flatMap((locale) => {
      return localizedContentPaths.map((source) => {
        const localizedPath = `/${locale}${source === "/" ? "" : source}`;
        return {
          source: localizedPath,
          destination: localizedPath,
        };
      });
    }),
    ...authRewritePaths(env).map((source) => {
      return { source, destination: source };
    }),
    ...SO_FRONTEND_FUNCTIONAL_PATHS.map((source) => {
      return { source, destination: source };
    }),
    ...SO_FRONTEND_ASSET_PATHS.map((source) => {
      return { source, destination: source };
    }),
  ];
}

export function resolveSoFrontendRewritePath(pathname, env = {}) {
  const match = rewriteSourceDefinitions(env).find(({ source }) => {
    return rewriteSourceMatchesPath(source, pathname);
  });
  if (!match) {
    return undefined;
  }

  return rewriteDestinationPath(match.source, match.destination, pathname);
}

export function matchesSoFrontendRewritePath(pathname, env = {}) {
  return resolveSoFrontendRewritePath(pathname, env) !== undefined;
}

export function buildSoFrontendRewrites(env) {
  const soFrontendUrl = resolveSoFrontendUrl(env);
  if (!soFrontendUrl) {
    return [];
  }

  const destinationPrefix = withoutTrailingSlash(soFrontendUrl);
  const localizedContentPaths = [
    ...SO_FRONTEND_EXACT_PATHS,
    ...SO_FRONTEND_WILDCARD_PATHS,
  ];

  return [
    ...SO_FRONTEND_EXACT_PATHS.map((source) => {
      return exactRewrite(source, destinationPrefix);
    }),
    ...SO_FRONTEND_WILDCARD_PATHS.map((source) => {
      return exactRewrite(source, destinationPrefix);
    }),
    ...LOCALES.flatMap((locale) => {
      return localizedContentPaths.map((source) => {
        return localizedExactRewrite(locale, source, destinationPrefix);
      });
    }),
    ...authRewritePaths(env).map((source) => {
      return exactRewrite(source, destinationPrefix);
    }),
    ...SO_FRONTEND_FUNCTIONAL_PATHS.map((source) => {
      return exactRewrite(source, destinationPrefix);
    }),
    ...SO_FRONTEND_ASSET_PATHS.map((source) => {
      return exactRewrite(source, destinationPrefix);
    }),
  ];
}
