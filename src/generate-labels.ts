// ── Pharmaceutical label generator ───────────────────────────────────────────
// Generates a printable HTML file (./labels.html) with 6 vial labels.
// Each label contains drug info + a real scannable Code 128 barcode of the NDC.
// Run with:  npx tsx src/generate-labels.ts
// Print with: open labels.html, then Cmd+P
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// @ts-ignore — bwip-js ships CommonJS; no @types package needed
import bwipjs from 'bwip-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface LabelData {
  drugName: string;
  strength: string;
  form: string;
  ndc: string;           // 10-digit, no dashes
  ndcFormatted: string;  // display format with dashes
  lot: string;
  exp: string;
  storage: string;
  manufacturer: string;
  warning?: string;
}

const LABELS: LabelData[] = [
  {
    drugName: 'Vancomycin HCl',
    strength: '500 mg/vial',
    form: 'For IV Infusion',
    ndc: '0409650801',
    ndcFormatted: '0409-6508-01',
    lot: 'VN24-8817A',
    exp: '12/2027',
    storage: 'Store at 20–25°C (68–77°F). Protect from light.',
    manufacturer: 'Pfizer Injectables',
    warning: 'VANCOMYCIN — OTOTOXIC / NEPHROTOXIC — Monitor levels',
  },
  {
    drugName: 'Sodium Chloride 0.9%',
    strength: '0.9% NaCl · 100 mL',
    form: 'IV Bag',
    ndc: '0338004911',
    ndcFormatted: '0338-0049-11',
    lot: 'NS25-3302B',
    exp: '06/2028',
    storage: 'Store at 15–30°C (59–86°F). Do not freeze.',
    manufacturer: 'Baxter Healthcare',
  },
  {
    drugName: 'Ceftriaxone Sodium',
    strength: '1 g/vial',
    form: 'For IV/IM Injection',
    ndc: '0409733701',
    ndcFormatted: '0409-7337-01',
    lot: 'CT26-0041F',
    exp: '03/2028',
    storage: 'Store at 20–25°C (68–77°F). Reconstituted: 24h/RT.',
    manufacturer: 'Pfizer Injectables',
    warning: 'Check for penicillin cross-allergy before administering',
  },
  {
    drugName: 'Heparin Sodium',
    strength: '5,000 units/mL',
    form: 'IV Injection',
    ndc: '0641044025',
    ndcFormatted: '0641-0440-25',
    lot: 'HP25-7190C',
    exp: '09/2027',
    storage: 'Store at 20–25°C (68–77°F). Do not freeze.',
    manufacturer: 'West-Ward Pharmaceuticals',
    warning: '⚠ HIGH ALERT — Anticoagulant — Verify dose independently',
  },
  {
    drugName: 'Dextrose 5% in Water',
    strength: 'D5W · 1000 mL',
    form: 'IV Bag',
    ndc: '0338001703',
    ndcFormatted: '0338-0017-03',
    lot: 'DX25-5518D',
    exp: '01/2028',
    storage: 'Store at 15–30°C (59–86°F). Do not freeze.',
    manufacturer: 'Baxter Healthcare',
  },
  {
    drugName: 'Morphine Sulfate',
    strength: '4 mg/mL · 1 mL',
    form: 'IV Injection',
    ndc: '0641607001',
    ndcFormatted: '0641-6070-01',
    lot: 'MS26-2284E',
    exp: '08/2027',
    storage: 'Store at 20–25°C (68–77°F). Protect from light.',
    manufacturer: 'West-Ward Pharmaceuticals',
    warning: '⚠ HIGH ALERT — Opioid — CII Controlled Substance',
  },
];

async function ndcToBarcode(ndc: string): Promise<string> {
  const png = await bwipjs.toBuffer({
    bcid:        'code128',   // Code 128 — standard for pharmaceutical NDC
    text:        ndc,
    scale:       3,
    height:      12,          // millimetres
    includetext: false,       // we print NDC as text separately
    backgroundcolor: 'ffffff',
  });
  return `data:image/png;base64,${(png as Buffer).toString('base64')}`;
}

function labelCard(label: LabelData, barcodeDataUrl: string): string {
  const warningHtml = label.warning
    ? `<div class="warning">${label.warning}</div>`
    : '';

  return `
  <div class="label">
    <div class="label-header">
      <div class="drug-name">${label.drugName}</div>
      <div class="rx-badge">Rx Only</div>
    </div>
    <div class="strength">${label.strength} &nbsp;·&nbsp; ${label.form}</div>
    ${warningHtml}
    <div class="barcode-row">
      <img class="barcode" src="${barcodeDataUrl}" alt="NDC barcode ${label.ndcFormatted}">
    </div>
    <div class="meta-grid">
      <div class="meta-cell">
        <span class="meta-label">NDC</span>
        <span class="meta-value">${label.ndcFormatted}</span>
      </div>
      <div class="meta-cell">
        <span class="meta-label">LOT</span>
        <span class="meta-value">${label.lot}</span>
      </div>
      <div class="meta-cell">
        <span class="meta-label">EXP</span>
        <span class="meta-value">${label.exp}</span>
      </div>
    </div>
    <div class="storage">${label.storage}</div>
    <div class="manufacturer">${label.manufacturer}</div>
  </div>`;
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    background: #e8e8e8;
    padding: 24px;
  }

  h1 {
    font-size: 13px;
    color: #555;
    margin-bottom: 20px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    max-width: 840px;
    margin: 0 auto;
  }

  .label {
    background: #fff;
    border: 1.5px solid #222;
    border-radius: 6px;
    padding: 10px 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .label-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .drug-name {
    font-size: 15px;
    font-weight: 700;
    color: #111;
    line-height: 1.2;
  }

  .rx-badge {
    font-size: 9px;
    font-weight: 700;
    border: 1.5px solid #111;
    border-radius: 3px;
    padding: 1px 4px;
    white-space: nowrap;
    color: #111;
    flex-shrink: 0;
    margin-left: 6px;
    margin-top: 1px;
    letter-spacing: 0.03em;
  }

  .strength {
    font-size: 11.5px;
    color: #333;
  }

  .warning {
    font-size: 9.5px;
    font-weight: 700;
    color: #fff;
    background: #b00;
    border-radius: 3px;
    padding: 2px 6px;
    line-height: 1.4;
  }

  .barcode-row {
    display: flex;
    justify-content: center;
    padding: 4px 0 2px;
  }

  .barcode {
    max-width: 100%;
    height: auto;
    display: block;
    image-rendering: pixelated;
  }

  .meta-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    border-top: 1px solid #ddd;
    border-bottom: 1px solid #ddd;
    padding: 4px 0;
  }

  .meta-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .meta-label {
    font-size: 7.5px;
    font-weight: 700;
    color: #777;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .meta-value {
    font-size: 10.5px;
    font-weight: 600;
    color: #111;
    font-family: 'Courier New', monospace;
  }

  .storage {
    font-size: 8.5px;
    color: #555;
    line-height: 1.35;
  }

  .manufacturer {
    font-size: 8px;
    color: #888;
    text-align: right;
  }

  /* ── Print styles ── */
  @media print {
    body {
      background: #fff;
      padding: 8mm;
    }
    h1 { display: none; }
    .grid {
      gap: 8mm;
      max-width: 100%;
    }
    .label {
      break-inside: avoid;
      border-color: #000;
    }
    .warning {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }
`;

async function main(): Promise<void> {
  console.log('Generating barcodes…');

  const cards = await Promise.all(
    LABELS.map(async (label) => {
      const dataUrl = await ndcToBarcode(label.ndc);
      console.log(`  ✓ ${label.drugName} (${label.ndcFormatted})`);
      return labelCard(label, dataUrl);
    })
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pharmaceutical Vial Labels</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>Pharmaceutical Vial Labels &mdash; Arcos AI Prototype</h1>
  <div class="grid">
${cards.join('\n')}
  </div>
</body>
</html>`;

  const outPath = path.resolve(__dirname, '..', 'labels.html');
  fs.writeFileSync(outPath, html, 'utf-8');
  console.log(`\nWritten → ${outPath}`);
  console.log('Open in a browser and press Cmd+P to print.');
}

main().catch((e) => {
  console.error('Failed:', e);
  process.exit(1);
});
