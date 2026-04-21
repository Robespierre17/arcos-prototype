import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface CompoundItem {
  name: string;
  quantity: string;
  ndc?: string;
  lotNumber?: string;
  expirationDate?: string;
}

interface ExtractionResult {
  sessionId: string;
  extractedAt: string;
  compounds: CompoundItem[];
  destination: string;
  safetyNotes: string[];
  rawTranscriptText: string;
}

export async function extractFromTranscript(transcriptPath: string): Promise<string> {
  const record = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
  const fullText = record.transcript.map((e: { text: string }) => e.text).join(' ');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are a pharmacy compounding data extractor. Extract structured information from the following compounding session transcript.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "compounds": [
    {
      "name": "<compound name>",
      "quantity": "<amount with units>",
      "ndc": "<NDC number if mentioned, else null>",
      "lotNumber": "<lot or batch number if mentioned, else null>",
      "expirationDate": "<expiration date if mentioned, else null>"
    }
  ],
  "destination": "<patient name, bed number, or room — wherever the preparation is going>",
  "safetyNotes": ["<any safety-relevant observations, warnings, beyond-use dating, storage requirements, administration notes>"]
}

Transcript:
${fullText}`,
      },
    ],
  });

  const content = message.content[0]!;
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  let parsed: { compounds: CompoundItem[]; destination: string; safetyNotes: string[] };
  try {
    parsed = JSON.parse(content.text);
  } catch {
    throw new Error(`Claude returned non-JSON response: ${content.text}`);
  }

  const extraction: ExtractionResult = {
    sessionId: record.sessionId,
    extractedAt: new Date().toISOString(),
    compounds: parsed.compounds,
    destination: parsed.destination,
    safetyNotes: parsed.safetyNotes,
    rawTranscriptText: fullText,
  };

  const basename = path.basename(transcriptPath, '.json');
  const extractionPath = path.join(path.dirname(transcriptPath), `${basename}-extraction.json`);
  fs.writeFileSync(extractionPath, JSON.stringify(extraction, null, 2));
  console.log(`[${new Date().toISOString()}] Extraction saved to ${extractionPath}`);

  return extractionPath;
}
