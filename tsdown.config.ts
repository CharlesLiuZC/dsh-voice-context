/**
 * Standalone tsdown config for the dsh-voice-context plugin.
 *
 * Two artifacts, both landing in `lib/`:
 *  - `lib/index.js` — the host half (plain ESM, run by the Node-side Loader);
 *  - `lib/client.js` — the browser half, emitted as a closure-factory bundle
 *    that calls `window.__ModuleLoader__.load({ id, factory })` and resolves
 *    platform modules through the injected `require` table.
 *
 * The platform-module list is the shell's frozen module table; anything else
 * under `@deepseek-ai/*` is inlined or erased (type-only imports never reach
 * the bundle). Keeping it here makes the package self-contained: `pnpm build`
 * works from a bare clone with no monorepo tooling.
 */
import type { UserConfig } from 'tsdown'

/** The module specifiers the DSH shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** Plugin id stamped into the loader handoff. */
const PLUGIN_ID = 'dsh-voice-context'

const nodeHalf: UserConfig = {
  name: PLUGIN_ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

const clientHalf: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_MODULES],
  // Browser bundles inline node-idiom deps that read process.env/import.meta.env.
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (id: string) => (PLATFORM_MODULES.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeHalf, clientHalf]
