/** The plugin system (internal entry for the CLI / SDK): loading, trust, scaffolding, testing. */
export { loadRegistry, locatePlugin, readManifest, pluginEntry, wantedPlugins, type LoadOptions, type LoadedPlugin, type LoadedRegistry, type LoadRegistryResult, type PluginManifest } from './loader.js';
export { trustPlugin, untrustPlugin, listTrusted, isTrusted, hashPlugin, trustStorePath, type TrustEntry } from './trust.js';
export { scaffoldPlugin, SCAFFOLD_KINDS, type ScaffoldKind } from './scaffold.js';
export { runPluginTests, type PluginTestResult, type PluginTestStep } from './test-runner.js';
export { satisfies, validRange, parseVersion, compareVersions } from './semver.js';
export { checkPluginDef, kindsOf, PLUGIN_KINDS, type PluginKind } from './validate.js';
export { PluginRegistry } from './registry.js';
