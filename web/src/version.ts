// The running build's identity. `appVersion` is for people; `appBuild` is the UTC minute stamp
// that update checks compare, because it moves with every build whether or not the semantic
// version was bumped.
//
// `typeof` on an undeclared identifier is safe, so a bundler or test runner that never substituted
// these constants falls back rather than failing to evaluate the module.

export const appVersion: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

export const appBuild: string = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "0";

/** "1.0.0 (202608231530)" -- what the About screen shows. */
export function appVersionLabel(): string {
  return `${appVersion} (${appBuild})`;
}
