// Bundles the server and the admin CLI into two plain-JavaScript files for the droplet (docs/deploy.md), so it
// needs Node.js but no node_modules: `npm run build -w @tdjr/server` writes dist/main.mjs and dist/admin.mjs.
// esbuild comes from the root node_modules (a tsx dependency). Adding it to this package.json would make npm 11
// rewrite the lockfile and drop rolldown's native bindings (see docs/STATUS.md).
import { build } from 'esbuild'

const version = process.env.NOTES_VERSION ?? 'dev'

await build({
  entryPoints: ['src/main.ts', 'src/admin.ts'],
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Some dependencies are CommonJS and call require().
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Optional native speed-ups that ws and pg load only if present.
  external: ['bufferutil', 'utf-8-validate', 'pg-native'],
  define: { __NOTES_VERSION__: JSON.stringify(version) },
  legalComments: 'linked',
  logLevel: 'warning',
})
console.log(`Built dist/main.mjs and dist/admin.mjs (${version}).`)
