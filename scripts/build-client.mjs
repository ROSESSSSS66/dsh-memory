import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function buildClient() {
  const isDev = process.env.NODE_ENV === 'development';
  const outdir = path.join(projectRoot, 'dist');
  const entryPoint = path.join(projectRoot, 'src', 'client', 'index.ts');
  const outfile = path.join(outdir, 'client.js');

  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    outfile,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    sourcemap: isDev,
    minify: !isDev,
    external: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    banner: {
      js:
        "if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') { " +
        'window.__ModuleLoader__.load({ id: "dsh-memory", factory: function(require) { \'use strict\'; var module = { exports: {} }; var exports = module.exports;',
    },
    footer: {
      js: '\nreturn module.exports; } }); }',
    },
  });

  console.log(`Client bundle built successfully to ${path.relative(projectRoot, outfile)}`);
}

buildClient().catch((err) => {
  console.error('Failed to build client:', err);
  process.exit(1);
});
