import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Options } from 'tsup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

const enableSourcemap =
  process.env.NODE_ENV === 'development' || Boolean(process.env.DSH_SOURCEMAP);
const enableMinify = process.env.NODE_ENV !== 'development';

const shared: Options = {
  format: ['esm'],
  splitting: false,
  clean: false,
  sourcemap: enableSourcemap,
  minify: enableMinify,
  target: 'node24',
  noExternal: ['zod', 'fzstd'],
  external: [/^@deepseek-ai\/.*/, /^node:.*/],
};

export default defineConfig(() => {
  // Clean dist once synchronously before parallel entry builds to avoid clean/write races
  fs.rmSync(distDir, { recursive: true, force: true });
  return [
    {
      ...shared,
      entry: {
        index: 'src/index.ts',
      },
      dts: true,
    },
    {
      ...shared,
      entry: {
        'eval-cli': 'src/eval/eval-cli.ts',
      },
      dts: false,
    },
  ];
});
