import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { processKeyframes } from './keyframes.js';

(async () => {
  const SESSIONS_DIR = path.resolve('./sessions');
  const framesDir = path.join(SESSIONS_DIR, 'test-frames');
  fs.mkdirSync(framesDir, { recursive: true });

  // frame-00001: solid grey — zero Laplacian response → BLURRY
  await sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 128, g: 128, b: 128 } },
  }).jpeg().toFile(path.join(framesDir, 'frame-00001.jpg'));

  // frame-00002: high-frequency noise → SHARP
  const noise = Buffer.alloc(128 * 128 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + i * i) % 256;
  await sharp(noise, { raw: { width: 128, height: 128, channels: 3 } })
    .jpeg().toFile(path.join(framesDir, 'frame-00002.jpg'));

  // frame-00003: same noise → DUPLICATE of frame-00002
  await sharp(noise, { raw: { width: 128, height: 128, channels: 3 } })
    .jpeg().toFile(path.join(framesDir, 'frame-00003.jpg'));

  // frame-00004: different noise → KEPT
  const noise2 = Buffer.alloc(128 * 128 * 3);
  for (let i = 0; i < noise2.length; i++) noise2[i] = (i * 53 + i * 7) % 256;
  await sharp(noise2, { raw: { width: 128, height: 128, channels: 3 } })
    .jpeg().toFile(path.join(framesDir, 'frame-00004.jpg'));

  console.log('Test frames created in', framesDir);
  console.log('Running keyframe pipeline…\n');

  const manifest = await processKeyframes(framesDir, { detectBarcodes: true });

  console.log('\n── Manifest ──────────────────────────────────────────');
  console.log(`Total frames: ${manifest.totalFrames}`);
  console.log(`Kept frames:  ${manifest.keptFrames}`);
  console.log('Per-frame results:');
  for (const f of manifest.frames) {
    const reasons = [
      f.blurScore < manifest.blurThreshold ? 'BLURRY' : '',
      f.isDuplicate ? 'DUPLICATE' : '',
      f.hasBarcode ? 'HAS_BARCODE' : '',
      f.kept ? 'KEPT' : 'DISCARDED',
    ].filter(Boolean).join('  ');
    console.log(`  ${f.filename}  blur=${f.blurScore.toFixed(0).padStart(6)}  ${reasons}`);
  }
  console.log('\nOutput dir:', manifest.outputDir);
  console.log('Files kept:', fs.readdirSync(manifest.outputDir).filter(f => f !== 'manifest.json').join(', '));

  // Clean up
  fs.rmSync(framesDir, { recursive: true });
  fs.rmSync(manifest.outputDir, { recursive: true });
  console.log('\nCleaned up test dirs.');
})();
