const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const uiPackagePath = path.resolve(workspaceRoot, "packages/ui");
const globalCssPath = path.join(uiPackagePath, "src", "global.css");
const tailwindConfigPath = path.join(projectRoot, "tailwind.config.js");

/** @type {import('expo/metro-config').MetroConfig} */
let config = getDefaultConfig(projectRoot, {
  isCSSEnabled: true,
});

// Preserve Expo monorepo discovery; ensure the shared UI package is watched.
const watchFolders = new Set([...(config.watchFolders ?? []), uiPackagePath]);
config.watchFolders = [...watchFolders];

// pnpm: resolve from the app first, then the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

// Web: resolve platform-specific `*.web.*` entry files.
const platforms = new Set(config.resolver.platforms ?? []);
platforms.add("web");
config.resolver.platforms = [...platforms];

const webSourceExtensions = ["web.tsx", "web.ts", "web.jsx", "web.js"];
const { sourceExts } = config.resolver;
config.resolver.sourceExts = [
  ...webSourceExtensions,
  ...sourceExts.filter((ext) => !webSourceExtensions.includes(ext)),
];

// NativeWind / react-native-css-interop: required for Tailwind on native + web Metro graphs.
config = withNativeWind(config, {
  input: globalCssPath,
  configPath: tailwindConfigPath,
});

module.exports = config;
