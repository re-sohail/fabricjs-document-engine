import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];

for (const file of ['dist/react.js', 'dist/react.cjs']) {
  if (!/^\s*["']use client["']/.test(readFileSync(file, 'utf8'))) problems.push(`${file} lost its "use client" directive`);
}

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

const reactImport = /from\s+["']react["']|require\(["']react["']\)/;
for (const file of filesIn('dist')) {
  const isReactFile = file.startsWith('dist/react');
  if (!isReactFile && /\.(c?js)$/.test(file) && reactImport.test(readFileSync(file, 'utf8'))) {
    problems.push(`${file} imports react, but only the react entry may`);
  }
}

// The PDF libraries are optional peers: only the pdf entry may load them,
// and only when a PDF is made, so importing it works without them.
const pdfImport = /["'](jspdf|svg2pdf\.js)["']/;
const staticPdfImport = /(?:^|\n)\s*import\s[^;]*["'](jspdf|svg2pdf\.js)["']|require\(["'](jspdf|svg2pdf\.js)["']\)/;
for (const file of filesIn('dist')) {
  if (!/\.(c?js)$/.test(file)) continue;
  const source = readFileSync(file, 'utf8');
  const isPdfFile = file.startsWith('dist/pdf');
  if (!isPdfFile && pdfImport.test(source)) problems.push(`${file} mentions jspdf or svg2pdf.js, but only the pdf entry may`);
  if (isPdfFile && staticPdfImport.test(source)) problems.push(`${file} imports jspdf or svg2pdf.js up front; it must load them only when a PDF is made`);
}

for (const file of filesIn('dist')) {
  if (file.endsWith('.cjs') && /require\(["']url["']\)/.test(readFileSync(file, 'utf8'))) problems.push(`${file} requires Node's url module, which browser bundles do not have`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Build verified: react entry keeps "use client", the core never imports react, and PDF libraries load only on demand.');
