// The Sentry bundler plugin embeds this key in every bundled application file,
// and thirdPartyErrorFilterIntegration reads it back at runtime to tell our own
// frames apart from scripts the browser or a third party injected into the page.
// The build-time and runtime values must stay identical: a mismatch would mark
// every frame as third-party code.
export const SENTRY_APPLICATION_KEY = "okou-platform";
