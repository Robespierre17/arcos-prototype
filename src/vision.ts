// ── Claude Vision label analysis ──────────────────────────────────────────────
//
// Sends a JPEG frame to Claude claude-sonnet-4-6 (vision) and asks it to extract
// any pharmaceutical label information visible in the image.
//
// Used as a fallback when ZXing finds no barcode in a captured frame AND the
// frame's dHash differs enough from the last frame that was sent to Vision.
// This keeps Vision API costs low: ZXing runs first (free, local), and Vision
// is only called once per visually-distinct scene.
//
// Returned schema:
//   {
//     barcode:        string | null,  // raw barcode / NDC text if visible
//     drugName:       string | null,  // compound / drug name from label
//     lotNumber:      string | null,
//     expirationDate: string | null,
//     otherText:      string | null,  // any other label text worth recording
//   }
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface VisionLabelResult {
  barcode:        string | null;
  drugName:       string | null;
  lotNumber:      string | null;
  expirationDate: string | null;
  otherText:      string | null;
}

const VISION_PROMPT = `You are analyzing a photo taken by smart glasses worn by a pharmacy compounding technician.
Look at this image and extract any pharmaceutical label information you can see.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "barcode":        "<raw barcode or NDC number text if visible, else null>",
  "drugName":       "<drug or compound name from any label text, else null>",
  "lotNumber":      "<lot or batch number if visible, else null>",
  "expirationDate": "<expiration date as printed if visible, else null>",
  "otherText":      "<any other label text worth recording — strength, volume, manufacturer, storage, warnings — else null>"
}

If nothing pharmaceutical is visible, return all fields as null.`;

/**
 * Send a JPEG file to Claude Vision and extract pharmaceutical label data.
 * Returns null if the API call fails (errors are logged but not re-thrown).
 */
export async function analyzeFrameWithVision(
  imagePath: string
): Promise<VisionLabelResult | null> {
  try {
    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64,
              },
            },
            {
              type: 'text',
              text: VISION_PROMPT,
            },
          ],
        },
      ],
    });

    const content = message.content[0]!;
    if (content.type !== 'text') {
      console.error(`[vision] Unexpected response type: ${content.type}`);
      return null;
    }

    // Strip markdown code fences if Claude wraps the JSON
    const raw = content.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const parsed = JSON.parse(raw) as VisionLabelResult;
    return parsed;
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [vision] Analysis failed:`, e);
    return null;
  }
}
