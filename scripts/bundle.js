import { readFileSync, writeFileSync, watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SRC = [
  { file: 'lib/format.js', strip: 'export ' },
  { file: 'lib/util.js', strip: 'export ' },
  { file: 'app.js', strip: null },
];

const HTML = join(root, 'index.html');
const MODULE_TAG = '<script type="module" src="app.js">';

function bundle() {
  let js = '';

  for (const { file, strip } of SRC) {
    const content = readFileSync(join(root, file), 'utf8');
    if (strip === null) {
      // app.js — remove import lines
      content = content.replace(/^import .* from\s+['"].*['"];\n?/gm, '');
    } else {
      // lib files — remove `export ` prefix
      content = content.replace(new RegExp('^' + strip, 'gm'), '');
    }
    js += content;
    if (!js.endsWith('\n')) js += '\n';
  }

  let html = readFileSync(HTML, 'utf8');
  const inline = '<script>\n' + js.trim() + '\n</script>';
  html = html.replace(MODULE_TAG, inline);

  writeFileSync(HTML, html, 'utf8');
  console.log('✓ Bundled into index.html (' + js.trim().split('\n').length + ' lines)');
}

const arg = process.argv[2];

if (arg === '--watch') {
  console.log('Watching for changes...');
  bundle();
  const watchPaths = SRC.map(s => join(root, s.file));
  for (const p of watchPaths) {
    watch(p, () => {
      try {
        bundle();
      } catch (e) {
        console.error('Build error:', e.message);
      }
    });
  }
} else {
  bundle();
}
