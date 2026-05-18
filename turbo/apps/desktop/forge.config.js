module.exports = {
  packagerConfig: {
    name: "Zero",
    executableName: "Zero",
    appBundleId: "ai.vm0.zero.desktop",
    asar: true,
    protocols: [
      {
        name: "Zero Desktop Auth",
        schemes: ["vm0"],
      },
    ],
    ignore: [/^\/node_modules($|\/)/],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
