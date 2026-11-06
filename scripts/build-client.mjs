import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

async function buildClient() {
  const outdir = 'dist';
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  await esbuild.build({
    entryPoints: ['src/client/index.ts'],
    bundle: true,
    outfile: 'dist/client.js',
    format: 'cjs',
    target: 'es2022',
    sourcemap: true,
    minify: false,
    external: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "dsh-memory", factory: function(require) { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: {
      js: '\nreturn module.exports; } });',
    },
  });

  console.log('Client bundle built successfully to dist/client.js');
}

buildClient().catch((err) => {
  console.error('Failed to build client:', err);
  process.exit(1);
});
