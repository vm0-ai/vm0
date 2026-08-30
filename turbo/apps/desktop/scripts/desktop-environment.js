function readDesktopEnvironment(key) {
  return process.env[key]?.trim() || undefined;
}

module.exports = { readDesktopEnvironment };
