const LOCALES = ["en", "de", "ja", "es"];

const SO_FRONTEND_EXACT_PATHS = [
  "/",
  "/pricing",
  "/security",
  "/rankings",
  "/illustration",
  "/web-design",
  "/presentation",
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

const SO_FRONTEND_ASSET_PATHS = [
  "/assets/:path*",
  "/images/:path*",
  "/favicon.ico",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/og-image.png",
  "/checkmark-primary.svg",
];

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
    ...SO_FRONTEND_AUTH_PATHS.map((source) => {
      return exactRewrite(source, destinationPrefix);
    }),
    ...SO_FRONTEND_ASSET_PATHS.map((source) => {
      return exactRewrite(source, destinationPrefix);
    }),
  ];
}
