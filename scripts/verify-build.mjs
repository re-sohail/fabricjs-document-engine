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

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Build verified: react entry keeps "use client" and the core never imports react.');
