/** YAML data files are converted to plain data at build time; see the plugin in `vite.config.ts`. */
declare module "*.yaml" {
  const data: unknown;
  export default data;
}
