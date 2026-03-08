import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from 'canvas';
import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const outputDir = path.join(repoRoot, 'public', 'markers');
const outputMindPath = path.join(outputDir, '4x4_1000-0.mind');
const inputPngPaths = Array.from({ length: 6 }, (_, i) =>
  path.join(outputDir, `4x4_1000-${i}-mind-target.png`)
);

for (const p of inputPngPaths) {
  if (!fs.existsSync(p)) {
    throw new Error(`Input marker not found: ${p}`);
  }
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log(`Compiling MindAR targets from:`);
for (const p of inputPngPaths) console.log(` - ${p}`);
const images = [];
for (const p of inputPngPaths) {
  images.push(await loadImage(p));
}
const compiler = new OfflineCompiler();

await compiler.compileImageTargets(images, (percent) => {
  console.log(`Progress: ${Math.round(percent)}%`);
});

const data = compiler.exportData();
fs.writeFileSync(outputMindPath, Buffer.from(data));
console.log(`Saved target: ${outputMindPath}`);
