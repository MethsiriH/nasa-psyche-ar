import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from 'canvas';
import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const inputSvgPath = path.join(repoRoot, 'public', 'markers', '4x4_1000-0-mind-target.png');
const outputDir = path.join(repoRoot, 'public', 'markers');
const outputMindPath = path.join(outputDir, '4x4_1000-0.mind');

if (!fs.existsSync(inputSvgPath)) {
  throw new Error(`Input marker not found: ${inputSvgPath}`);
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log(`Compiling MindAR target from: ${inputSvgPath}`);
const image = await loadImage(inputSvgPath);
const compiler = new OfflineCompiler();

await compiler.compileImageTargets([image], (percent) => {
  console.log(`Progress: ${Math.round(percent)}%`);
});

const data = compiler.exportData();
fs.writeFileSync(outputMindPath, Buffer.from(data));
console.log(`Saved target: ${outputMindPath}`);
