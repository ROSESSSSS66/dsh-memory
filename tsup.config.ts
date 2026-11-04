import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'eval-cli': 'src/eval/eval-cli.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node24',
  external: [
    /^@deepseek-ai\/.*/,
    /^node:.*/
  ]
});
