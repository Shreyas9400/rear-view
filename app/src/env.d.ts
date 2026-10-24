// Minimal Vite typings (the project does not pull in vite/client).
interface ImportMetaEnv {
  /** '1' only in the on-device self-test build; absent in production, so the self-test is dead-code eliminated. */
  readonly VITE_SELFTEST?: string;
  /** '1' starts the pipeline on launch (device test builds only). */
  readonly VITE_AUTOSTART?: string;
  /** '1' logs PRODUCT_STATUS lines every 5 s (device test builds only). */
  readonly VITE_PRODUCT_LOG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*?url' {
  const url: string;
  export default url;
}
