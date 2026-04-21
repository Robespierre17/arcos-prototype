// ── Keyframe filtering pipeline ───────────────────────────────────────────────
//
// SDK camera investigation findings (2026-04-17):
//   The @mentra/sdk provides no local video recording. session.camera.requestPhoto()
//   is the only path to saving media locally, producing one JPEG per call.
//   This pipeline post-processes those frames to produce a de-noised set.
//
// Pipeline stages (applied per-frame in order):
//   1. Blur filter  — Laplacian variance on a 256×256 grayscale thumbnail.
//                     Frames below BLUR_THRESHOLD are discarded.
//                     We compute the Laplacian manually from raw pixels to avoid
//                     sharp's clamping of negative convolution outputs.
//
//   2. Duplicate filter — 64-bit dHash (difference hash): resize to 9×8 grayscale,
//                     compare adjacent pixel brightness per row → 64 bits.
//                     Hamming distance ≤ DUPLICATE_HASH_THRESHOLD from the previous
//                     kept frame → discard.
//
//   3. Barcode detection — sharp outputs grayscale as Uint8ClampedArray, passed
//                     directly to @zxing/library's RGBLuminanceSource as pre-computed
//                     luminance (the Uint8ClampedArray branch skips ARGB unpacking).
//                     Handles QR, PDF417, Code128, Code39, DataMatrix, etc.
//                     Enabled by default; pass { detectBarcodes: false } to skip.
//
// Output:
//   "Good" frames are hard-linked to ./sessions/{ts}-keyframes/.
//   A manifest.json is written there with per-frame metadata.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { analyzeFrameWithVision } from './vision.js';
import {
  BinaryBitmap,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
  NotFoundException,
  Result,
} from '@zxing/library';

// ── Tuning constants ──────────────────────────────────────────────────────────
// Laplacian variance: higher = sharper. Empirically, a crisp 720p frame is
// typically 300–2000+; motion-blurred frames drop below ~100.
const BLUR_THRESHOLD = 100;

// dHash Hamming distance (0–64). Two frames from a static scene typically score
// 0–5; genuine scene changes score 15+. 10 is a safe "near-duplicate" cutoff.
const DUPLICATE_HASH_THRESHOLD = 10;
// ─────────────────────────────────────────────────────────────────────────────

export interface FrameMetadata {
  filename: string;
  blurScore: number;     // Laplacian variance — higher means sharper
  pHash: string;         // 64-bit dHash as 16-char hex string
  isDuplicate: boolean;  // Hamming distance from previous kept frame ≤ threshold
  hasBarcode: boolean;   // @zxing/library found a barcode in this frame
  barcodeText?: string;  // Decoded barcode value (NDC, QR text, etc.)
  // Vision API fields — populated when ZXing finds no barcode
  visionAnalyzed?: boolean;
  visionDrugName?: string;
  visionLotNumber?: string;
  visionExpirationDate?: string;
  visionOtherText?: string;
  kept: boolean;         // true if not blurry AND not a duplicate
}

export interface KeyframeManifest {
  sourceDir: string;
  outputDir: string;
  processedAt: string;
  totalFrames: number;
  keptFrames: number;
  blurThreshold: number;
  duplicateHashThreshold: number;
  frames: FrameMetadata[];
}

// ── Stage 1: Blur detection ───────────────────────────────────────────────────
// Resize to 256×256 grayscale, pull raw bytes, apply 4-connected Laplacian
// kernel manually, return variance of the response.
async function computeBlurScore(imagePath: string): Promise<number> {
  const { data, info } = await sharp(imagePath)
    .grayscale()
    .resize(256, 256, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  let sum = 0;
  let sumSq = 0;
  let n = 0;

  // Skip border pixels so all four neighbours are always in-bounds
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // Laplacian: centre×4 − 4 direct neighbours
      const lap =
        4 * (data[i] ?? 0)
        - (data[i - 1] ?? 0)
        - (data[i + 1] ?? 0)
        - (data[i - w] ?? 0)
        - (data[i + w] ?? 0);
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }

  const mean = sum / n;
  return sumSq / n - mean * mean; // variance of Laplacian response
}

// ── Stage 2: Perceptual hashing (dHash) ──────────────────────────────────────
// Resize to 9×8 grayscale. For each of 8 rows, emit 1 bit per column:
// 1 if pixel[col] > pixel[col+1], else 0. Produces a 64-bit hash.
export async function computeDHash(imagePath: string): Promise<bigint> {
  const { data } = await sharp(imagePath)
    .resize(9, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const idx = row * 9 + col;
      const bit = (data[idx] ?? 0) > (data[idx + 1] ?? 0) ? 1n : 0n;
      hash = (hash << 1n) | bit;
    }
  }
  return hash;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let dist = 0;
  while (diff > 0n) {
    dist += Number(diff & 1n);
    diff >>= 1n;
  }
  return dist;
}

// ── Stage 3: Barcode detection ────────────────────────────────────────────────
// sharp outputs grayscale as a Uint8ClampedArray. RGBLuminanceSource detects
// the Uint8ClampedArray path (BYTES_PER_ELEMENT === 1) and uses the values
// directly as luminance — no ARGB packing required.
//
// readBarcodeText() is exported so index.ts can run real-time detection on
// each captured frame without duplicating the ZXing setup.
const zxingReader = new MultiFormatReader();

/**
 * Attempt to decode a barcode in the given JPEG.
 * Returns the decoded text string if found, or null if no barcode is present.
 * Accepts NDC barcodes (Code128, Code39, PDF417), QR codes, DataMatrix, etc.
 */
export async function readBarcodeText(imagePath: string): Promise<string | null> {
  try {
    const { data, info } = await sharp(imagePath)
      .resize({ width: 800, withoutEnlargement: true })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const luminance = new Uint8ClampedArray(data);
    const source = new RGBLuminanceSource(luminance, info.width, info.height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const result: Result = zxingReader.decode(bitmap);
    return result.getText();
  } catch (e) {
    if (e instanceof NotFoundException) return null; // normal "no barcode" path
    return null; // malformed image or other decode error
  }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
export async function processKeyframes(
  framesDir: string,
  options: { detectBarcodes?: boolean; useVision?: boolean } = {}
): Promise<KeyframeManifest> {
  const { detectBarcodes = true, useVision = true } = options;

  if (!fs.existsSync(framesDir)) {
    throw new Error(`Frames directory not found: ${framesDir}`);
  }

  // Output dir mirrors the frames dir name, swapping the suffix
  const outputDir = framesDir.endsWith('-frames')
    ? framesDir.slice(0, -'-frames'.length) + '-keyframes'
    : framesDir + '-keyframes';

  fs.mkdirSync(outputDir, { recursive: true });

  const files = fs.readdirSync(framesDir)
    .filter(f => /\.(jpg|jpeg)$/i.test(f))
    .sort();

  const frames: FrameMetadata[] = [];
  let lastKeptHash: bigint | null = null;
  let lastVisionHash: bigint | null = null;
  let keptCount = 0;

  for (const filename of files) {
    const sourcePath = path.join(framesDir, filename);

    const blurScore = await computeBlurScore(sourcePath);
    const isBlurry = blurScore < BLUR_THRESHOLD;

    const hash = await computeDHash(sourcePath);
    const pHash = hash.toString(16).padStart(16, '0');

    let isDuplicate = false;
    if (!isBlurry && lastKeptHash !== null) {
      isDuplicate = hammingDistance(hash, lastKeptHash) <= DUPLICATE_HASH_THRESHOLD;
    }

    const barcodeText = detectBarcodes ? await readBarcodeText(sourcePath) : null;
    const hasBarcode = barcodeText !== null;

    const kept = !isBlurry && !isDuplicate;

    if (kept) {
      fs.copyFileSync(sourcePath, path.join(outputDir, filename));
      lastKeptHash = hash;
      keptCount++;
    }

    const meta: FrameMetadata = { filename, blurScore, pHash, isDuplicate, hasBarcode, kept };
    if (barcodeText !== null) meta.barcodeText = barcodeText;

    // ── Vision fallback ─────────────────────────────────────────────────────
    // For kept frames where ZXing found no barcode, call Claude Vision to
    // extract label text. Only call when the frame is visually distinct from
    // the last frame that was analysed (Hamming distance > 10).
    if (kept && !hasBarcode && useVision) {
      const visionDistance = lastVisionHash !== null
        ? hammingDistance(hash, lastVisionHash)
        : 64;

      if (visionDistance > 10) {
        lastVisionHash = hash;
        const label = await analyzeFrameWithVision(sourcePath);
        if (label) {
          meta.visionAnalyzed = true;
          if (label.drugName)       meta.visionDrugName       = label.drugName;
          if (label.lotNumber)      meta.visionLotNumber      = label.lotNumber;
          if (label.expirationDate) meta.visionExpirationDate = label.expirationDate;
          if (label.otherText)      meta.visionOtherText      = label.otherText;
          // If Vision found a barcode that ZXing missed, record it
          if (label.barcode) {
            meta.barcodeText = label.barcode;
            meta.hasBarcode  = true;
          }
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    frames.push(meta);

    console.log(
      `[${new Date().toISOString()}] [keyframes] ${filename}` +
      ` blur=${blurScore.toFixed(0)} dup=${isDuplicate} barcode=${hasBarcode}` +
      (meta.visionAnalyzed ? ` vision=yes drug=${meta.visionDrugName ?? 'none'}` : '') +
      ` kept=${kept}`
    );
  }

  const manifest: KeyframeManifest = {
    sourceDir: framesDir,
    outputDir,
    processedAt: new Date().toISOString(),
    totalFrames: files.length,
    keptFrames: keptCount,
    blurThreshold: BLUR_THRESHOLD,
    duplicateHashThreshold: DUPLICATE_HASH_THRESHOLD,
    frames,
  };

  fs.writeFileSync(
    path.join(outputDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.log(
    `[${new Date().toISOString()}] [keyframes] Done: kept ${keptCount}/${files.length} frames → ${outputDir}`
  );

  return manifest;
}
