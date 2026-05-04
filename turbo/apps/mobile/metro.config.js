/* eslint-disable */
const { getDefaultConfig } = require("expo/metro-config");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Watch workspace packages for changes
config.watchFolders = [
  ...(config.watchFolders || []),
  // Add workspace package paths here as needed
];

module.exports = config;
