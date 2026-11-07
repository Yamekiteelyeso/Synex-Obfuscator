// Empaqueta la aplicación web con esbuild en dist/ (index.html, app.js, styles.css).
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, 'src/main.tsx')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  jsx: 'automatic',
  outfile: join(out, 'app.js'),
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'css' },
  logLevel: 'warning',
});
await copyFile(join(root, 'index.html'), join(out, 'index.html'));
await copyFile(join(root, 'src/styles.css'), join(out, 'styles.css'));
console.log('apps/web compilada en', out);
