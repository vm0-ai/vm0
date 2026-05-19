module.exports = {
  packagerConfig: {
    name: "Zero",
    executableName: "Zero",
    appBundleId: "ai.vm0.zero.desktop",
    asar: false,
    osxSign: {
      hardenedRuntime: false,
      identity: "-",
      identityValidation: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
      }),
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
    },
    protocols: [
      {
        name: "Zero Desktop Auth",
        schemes: ["vm0"],
      },
    ],
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/src($|\/)/,
      /^\/\.turbo($|\/)/,
      /^\/\.npmrc$/,
      /^\/README\.md$/,
      /^\/forge\.config\.js$/,
      /^\/tsconfig\.json$/,
      /^\/vitest\.config\.ts$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
