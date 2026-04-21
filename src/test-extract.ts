import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { extractFromTranscript } from './extract.js';

const sessionFile = path.resolve('./sessions/2026-04-16T01-16-35.359Z.json');

console.log('Running extraction on:', sessionFile);
extractFromTranscript(sessionFile)
  .then((outputPath) => {
    console.log('Success! Extraction written to:', outputPath);
    console.log(fs.readFileSync(outputPath, 'utf-8'));
  })
  .catch((e) => {
    console.error('Extraction failed:', e.message);
    process.exit(1);
  });
