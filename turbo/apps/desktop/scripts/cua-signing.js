const path = require("node:path");
const manifest = require("../cua/artifacts.json");

function cuaSigningBinaries(appPath) {
  return manifest.nativeCode.map((file) =>
    path.join(appPath, "Contents", "Resources", "cua", file),
  );
}

module.exports = { cuaSigningBinaries };
