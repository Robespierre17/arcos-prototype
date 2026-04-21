// ── NDC lookup table ──────────────────────────────────────────────────────────
// Keys are 10-digit NDC strings with no dashes (the format barcodes typically
// encode). lookupNdc() normalises the raw barcode text before lookup, so
// dashed formats like "0409-6508-01" also match.
//
// NDC format varies by labeler (4-4-2, 5-3-2, 5-4-1, or 11-digit FDA).
// We store the 10-digit form and accept any input that reduces to it.
// ─────────────────────────────────────────────────────────────────────────────

export interface NdcEntry {
  name: string;            // Drug name for TTS — keep concise, no abbreviations
  concentration: string;   // Strength / volume (e.g. "500 mg/vial")
  form: string;            // Dosage form (e.g. "IV infusion")
  manufacturer?: string;
}

const NDC_TABLE: Record<string, NdcEntry> = {
  // ── Antibiotics ────────────────────────────────────────────────────────────
  '0409650801': { name: 'Vancomycin',               concentration: '500 mg/vial',       form: 'IV infusion',   manufacturer: 'Pfizer Injectables' },
  '0143992410': { name: 'Ampicillin',               concentration: '1 g/vial',           form: 'IV injection' },
  '0143921610': { name: 'Cefazolin',                concentration: '1 g/vial',           form: 'IV injection' },
  '0641036325': { name: 'Gentamicin',               concentration: '80 mg per 2 mL',     form: 'IV injection' },
  '0049002783': { name: 'Piperacillin Tazobactam',  concentration: '3.375 g/vial',       form: 'IV infusion' },
  '0338180141': { name: 'Metronidazole',            concentration: '500 mg per 100 mL',  form: 'IV infusion',   manufacturer: 'Baxter' },
  '0781566310': { name: 'Meropenem',                concentration: '1 g/vial',           form: 'IV injection' },
  '0143985625': { name: 'Ciprofloxacin',            concentration: '400 mg per 200 mL',  form: 'IV infusion' },

  // ── IV solutions ───────────────────────────────────────────────────────────
  '0338004911': { name: 'Normal Saline',            concentration: '0.9% NaCl 100 mL',  form: 'IV bag',        manufacturer: 'Baxter' },
  '0338003604': { name: 'Normal Saline',            concentration: '0.9% NaCl 250 mL',  form: 'IV bag',        manufacturer: 'Baxter' },
  '0264780020': { name: 'Normal Saline',            concentration: '0.9% NaCl 250 mL',  form: 'IV bag',        manufacturer: 'B. Braun' },
  '0264750020': { name: 'Dextrose 5 percent',       concentration: 'D5W 250 mL',         form: 'IV bag',        manufacturer: 'B. Braun' },
  '0338017104': { name: 'Lactated Ringers',         concentration: '1000 mL',            form: 'IV bag',        manufacturer: 'Baxter' },
  '0264967100': { name: 'Potassium Chloride',       concentration: '20 mEq per 100 mL',  form: 'IV bag',        manufacturer: 'B. Braun' },
  '0264796020': { name: 'Magnesium Sulfate',        concentration: '4 g per 100 mL',     form: 'IV bag',        manufacturer: 'B. Braun' },

  // ── Analgesics & sedation ──────────────────────────────────────────────────
  '0641600825': { name: 'Morphine Sulfate',         concentration: '4 mg per mL',        form: 'IV injection' },
  '0641458025': { name: 'Hydromorphone',            concentration: '2 mg per mL',        form: 'IV injection' },
  '0069310014': { name: 'Fentanyl',                 concentration: '50 mcg per mL',      form: 'IV injection',  manufacturer: 'Pfizer' },
  '0143978925': { name: 'Midazolam',                concentration: '5 mg per mL',        form: 'IV injection' },
  '0641601635': { name: 'Lorazepam',                concentration: '2 mg per mL',        form: 'IV injection' },

  // ── Cardiac & other ────────────────────────────────────────────────────────
  '0641039125': { name: 'Heparin',                  concentration: '5000 units per mL',  form: 'IV injection' },
  '0781302031': { name: 'Furosemide',               concentration: '40 mg per 4 mL',     form: 'IV injection' },
  '0641001025': { name: 'Ondansetron',              concentration: '4 mg per 2 mL',      form: 'IV injection' },
  '0186077710': { name: 'Amiodarone',               concentration: '150 mg per 3 mL',    form: 'IV injection',  manufacturer: 'AstraZeneca' },
  '0641610435': { name: 'Dopamine',                 concentration: '400 mg per 250 mL',  form: 'IV infusion' },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up an NDC number in the table. Accepts any format:
 *   "0409650801"  (no dashes, 10 digits)
 *   "0409-6508-01" (dashed)
 *   "00409650801"  (11-digit FDA format — leading zero stripped)
 * Returns null if not found.
 */
export function lookupNdc(raw: string): NdcEntry | null {
  const digits = raw.replace(/\D/g, '');
  // FDA 11-digit → 10-digit: strip leading zero of each segment if needed.
  // Simplest heuristic that covers the common case: if 11 digits, try dropping
  // the first character (the labeler padding zero).
  const key10 = digits.length === 11 ? digits.slice(1) : digits;
  return NDC_TABLE[key10] ?? NDC_TABLE[digits] ?? null;
}

/**
 * Format a barcode/NDC string so TTS reads it as individual digit groups
 * rather than a large integer.
 *
 * "0409650801" → "0409 6508 01"  (spoken as digit pairs/groups)
 */
export function formatNdcForSpeech(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    // Standard 5-4-2 presentation with spaces for natural TTS rhythm
    return `${digits.slice(0, 5)} ${digits.slice(5, 9)} ${digits.slice(9)}`;
  }
  if (digits.length === 11) {
    return `${digits.slice(0, 5)} ${digits.slice(5, 10)} ${digits.slice(10)}`;
  }
  // Non-NDC barcode — return as-is (might be a QR or other format)
  return raw.length > 30 ? raw.slice(0, 30) + '…' : raw;
}
