import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { AppServer } from '@mentra/sdk';
import { extractFromTranscript } from './extract.js';
import { processKeyframes, readBarcodeText, computeDHash, hammingDistance } from './keyframes.js';
import { lookupNdc, formatNdcForSpeech } from './ndc-lookup.js';
import { analyzeFrameWithVision } from './vision.js';
import type { Request, Response } from 'express';

const SESSIONS_DIR = path.resolve('./sessions');

interface TranscriptEntry {
  timestamp: string;
  text: string;
  utteranceId?: string;
  speakerId?: string;
  startTime: number;
  endTime: number;
}

interface SessionRecord {
  sessionId: string;
  userId: string;
  startTime: string;
  endTime: string;
  transcript: TranscriptEntry[];
}

// ── SDK audio/camera capabilities (inspected 2026-04-17) ─────────────────────
//
// AUDIO — session.audio (AudioManager)
//   session.audio.speak(text, opts?)  → Promise<AudioPlayResult>
//     Converts text to speech via ElevenLabs and plays on glasses speakers.
//     opts.voice_id, opts.voice_settings, opts.volume, opts.stopOtherAudio
//     opts.trackId: 0=speaker, 1=app_audio, 2=tts (default for speak)
//     Requires ELEVENLABS_DEFAULT_VOICE_ID configured server-side; errors are
//     non-fatal — we log and continue.
//   session.audio.playAudio({ audioUrl, volume?, trackId? })
//     Plays a pre-hosted audio file (MP3/WAV) by URL. No built-in beep/tone
//     generator — a URL to a hosted sound file would be required.
//   → speak() is the right choice for confirmation messages.
//
// CAMERA — session.camera (CameraModule)
//   session.camera.requestPhoto(opts?) → Promise<PhotoData { buffer: Buffer }>
//   No local video recording; both streaming options (startStream/
//   startManagedStream) require external infrastructure.
//   → Photo polling every ~2 seconds is the only local-save path.
//
// VOICE COMMANDS — state machine driven by transcription events
//   IDLE     → "Arcos start session" → RECORDING
//   RECORDING → "Arcos end session"  → IDLE  (saves, runs pipelines)
//   Command phrases are excluded from the saved transcript.
// ─────────────────────────────────────────────────────────────────────────────

class CompoundLoggerApp extends AppServer {
  protected async onSession(session: any, sessionId: string, userId: string) {
    console.log(`[${new Date().toISOString()}] Session connected: ${sessionId} — waiting for "Arcos start session"`);

    // ── State ─────────────────────────────────────────────────────────────────
    let isRecording = false;
    let recordingStartTime: Date | null = null;
    let framesDir = '';
    let transcript: TranscriptEntry[] = [];
    const utteranceMap = new Map<string, TranscriptEntry>();
    let frameIndex = 0;
    let captureStopped = true;
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    // Last barcode text seen this session — prevents re-announcing the same
    // compound on every frame while the camera lingers over a label.
    let lastSeenBarcode: string | null = null;
    // dHash of the last frame sent to Vision API — avoids calling Vision on
    // visually-identical frames when ZXing finds nothing.
    let lastVisionHash: bigint | null = null;
    // Timestamp of the last partial transcription — used to detect active speech.
    let lastPartialTime = 0;
    // Queue of TTS messages to play once the user stops speaking.
    const ttsQueue: string[] = [];
    let ttsFlushTimer: ReturnType<typeof setTimeout> | undefined;

    // ── TTS confirmation ──────────────────────────────────────────────────────
    // If the user is actively speaking (partial received in the last 3 s), the
    // message is queued and played once a 3-second silence gap is detected.
    // This prevents TTS from talking over the user's voice.
    // Fire-and-forget: session logic never waits on audio.
    function playTts(text: string): void {
      (session.audio.speak(text, { stopOtherAudio: false }) as Promise<unknown>)
        .catch((e: Error) =>
          console.error(`[${new Date().toISOString()}] TTS failed: ${e.message}`)
        );
    }

    function flushTtsQueue(): void {
      ttsFlushTimer = undefined;
      if (ttsQueue.length === 0) return;
      if (Date.now() - lastPartialTime < 3000) {
        // User still speaking — check again in 500 ms
        ttsFlushTimer = setTimeout(flushTtsQueue, 500);
        return;
      }
      // Silence gap reached — drain one item, then schedule the next check
      const text = ttsQueue.shift()!;
      console.log(`[${new Date().toISOString()}] TTS (dequeued): "${text}"`);
      playTts(text);
      if (ttsQueue.length > 0) {
        ttsFlushTimer = setTimeout(flushTtsQueue, 500);
      }
    }

    function confirm(text: string): void {
      console.log(`[${new Date().toISOString()}] TTS: "${text}"`);
      if (Date.now() - lastPartialTime < 3000) {
        // User is actively speaking — queue for after the silence gap
        console.log(`[${new Date().toISOString()}] TTS queued (user speaking)`);
        ttsQueue.push(text);
        if (ttsFlushTimer === undefined) {
          ttsFlushTimer = setTimeout(flushTtsQueue, 500);
        }
        return;
      }
      playTts(text);
    }

    // ── Photo capture ─────────────────────────────────────────────────────────
    // Recursive setTimeout — each 2 s window begins after the previous photo
    // finishes, so slow captures never queue up overlapping requests.
    // When TTS is triggered, the next frame is delayed by an extra 3 s so the
    // speaker finishes before the mic resumes, preventing TTS echo in the
    // transcript.
    async function captureFrame(): Promise<void> {
      if (captureStopped) return;
      let ttsTriggered = false;
      try {
        const photo = await session.camera.requestPhoto({ size: 'medium', compress: 'medium' });
        const name = `frame-${String(frameIndex).padStart(5, '0')}.jpg`;
        const framePath = path.join(framesDir, name);
        fs.writeFileSync(framePath, photo.buffer as Buffer);
        frameIndex++;
        console.log(`[${new Date().toISOString()}] Frame ${frameIndex} saved (${photo.size} bytes)`);

        // ── Real-time label analysis ────────────────────────────────────────
        // Stage 1: ZXing (fast, local). Announces immediately when a new
        //          barcode is found.
        // Stage 2: Claude Vision (slow, paid). Only called when ZXing finds
        //          nothing AND the frame is visually distinct from the last
        //          frame that was sent to Vision (pHash Hamming distance > 10).
        const barcodeText = await readBarcodeText(framePath);

        if (barcodeText !== null) {
          // ZXing found a barcode — announce if new
          if (barcodeText !== lastSeenBarcode) {
            lastSeenBarcode = barcodeText;
            const entry = lookupNdc(barcodeText);
            const message = entry
              ? `${entry.name} confirmed`
              : `Unknown compound, N D C ${formatNdcForSpeech(barcodeText)}`;
            console.log(`[${new Date().toISOString()}] Barcode (ZXing): "${barcodeText}" → ${message}`);
            confirm(message);
            ttsTriggered = true;
          }
        } else {
          // ZXing found nothing — try Vision if the scene has changed enough
          const frameHash = await computeDHash(framePath);
          const visionDistance = lastVisionHash !== null
            ? hammingDistance(frameHash, lastVisionHash)
            : 64; // treat first frame as always distinct

          if (visionDistance > 10) {
            lastVisionHash = frameHash;
            console.log(`[${new Date().toISOString()}] No barcode — sending frame to Vision API (hash dist ${visionDistance})`);
            const label = await analyzeFrameWithVision(framePath);
            if (label) {
              console.log(`[${new Date().toISOString()}] Vision result:`, JSON.stringify(label));

              // Announce barcode/NDC from Vision if new
              if (label.barcode && label.barcode !== lastSeenBarcode) {
                lastSeenBarcode = label.barcode;
                const entry = lookupNdc(label.barcode);
                const message = entry
                  ? `${entry.name} confirmed`
                  : `Unknown compound, N D C ${formatNdcForSpeech(label.barcode)}`;
                console.log(`[${new Date().toISOString()}] Barcode (Vision): "${label.barcode}" → ${message}`);
                confirm(message);
                ttsTriggered = true;
              } else if (label.drugName) {
                // No scannable barcode but Vision read a drug name from the label
                const drugMsg = `Label reads ${label.drugName}`;
                console.log(`[${new Date().toISOString()}] Drug name (Vision): "${label.drugName}"`);
                confirm(drugMsg);
                ttsTriggered = true;
              }
            }
          }
        }
        // ──────────────────────────────────────────────────────────────────
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Frame capture error:`, e);
      }
      // Add 3 s after TTS so the speaker finishes before the mic resumes
      if (!captureStopped) captureTimer = setTimeout(captureFrame, ttsTriggered ? 5000 : 2000);
    }

    function startCapture(dir: string): void {
      framesDir = dir;
      frameIndex = 0;
      captureStopped = false;
      fs.mkdirSync(framesDir, { recursive: true });
      captureTimer = setTimeout(captureFrame, 2000); // first frame after 2 s
    }

    function stopCapture(): void {
      captureStopped = true;
      clearTimeout(captureTimer);
    }

    // ── Utterance buffer for multi-utterance command detection ────────────────
    // The transcriber sometimes splits commands across two final utterances.
    // We keep a rolling window of the last 3 finals, strip punctuation, join
    // with a space, and match trigger phrases against the combined string.
    const COMMAND_BUFFER_SIZE = 3;
    const utteranceBuffer: string[] = [];

    function pushAndMatch(text: string): { wantsStart: boolean; wantsEnd: boolean } {
      // Normalise: lowercase, remove apostrophes first (so "arco's" → "arcos",
      // not "arco s"), then replace remaining punctuation with spaces, then
      // collapse runs of whitespace.
      const clean = text.toLowerCase()
        .replace(/['\u2018\u2019`]/g, '')  // strip apostrophes without inserting a space
        .replace(/[^\w\s]/g, ' ')          // replace other punctuation with space
        .replace(/\s+/g, ' ')              // collapse multiple spaces
        .trim();
      utteranceBuffer.push(clean);
      if (utteranceBuffer.length > COMMAND_BUFFER_SIZE) utteranceBuffer.shift();

      // Check both the joined rolling window (catches splits across utterances)
      // AND the current utterance alone (catches phrases embedded at the end of
      // a longer single utterance regardless of what's in the buffer).
      const window = utteranceBuffer.join(' ');
      const matchesStart = (s: string) => s.includes('start session');
      const matchesEnd   = (s: string) => s.includes('end session');

      return {
        wantsStart: matchesStart(window) || matchesStart(clean),
        wantsEnd:   matchesEnd(window)   || matchesEnd(clean),
      };
    }

    // ── Transcription handler ─────────────────────────────────────────────────
    session.events.onTranscription((data: any) => {
      const text: string = data.text ?? '';
      console.log(`[${new Date().toISOString()}] [${data.isFinal ? 'final' : 'partial'}] ${text}`);

      if (!data.isFinal) {
        // Record active-speech timestamp so confirm() can gate TTS playback.
        lastPartialTime = Date.now();
        return;
      }

      // ── TTS echo suppression ──────────────────────────────────────────────
      // The glasses mic picks up its own speaker output. Drop short utterances
      // that match phrases the app itself speaks. Long utterances (≥ 30 words)
      // are treated as real speech — the TTS output is short, so a long
      // transcription can't be a pure echo even if it shares a few words.
      const textLower = text.toLowerCase().replace(/['\u2018\u2019`]/g, '');
      const wordCount = text.trim().split(/\s+/).length;
      const isEchoPhrase =
        textLower.includes('confirmed') ||
        textLower.includes('unknown compound') ||
        textLower.includes('label reads') ||
        textLower.includes('session started') ||
        textLower.includes('session ended');
      if (isEchoPhrase && wordCount < 30) {
        console.log(`[${new Date().toISOString()}] [echo-suppressed] ${text}`);
        return;
      }
      // ─────────────────────────────────────────────────────────────────────

      const { wantsStart, wantsEnd } = pushAndMatch(text);

      // ── Command detection debug ───────────────────────────────────────────
      {
        const clean = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(`[${new Date().toISOString()}] [cmd-debug] normalized: "${clean}"`);
        console.log(`[${new Date().toISOString()}] [cmd-debug] buffer: ${JSON.stringify(utteranceBuffer)}`);
        console.log(`[${new Date().toISOString()}] [cmd-debug] wantsStart=${wantsStart} wantsEnd=${wantsEnd} isRecording=${isRecording}`);
      }
      // ─────────────────────────────────────────────────────────────────────

      // ── IDLE: listen only for the start command ───────────────────────────
      if (!isRecording) {
        if (wantsStart) {
          utteranceBuffer.length = 0; // clear so the phrase can't re-trigger
          recordingStartTime = new Date();
          transcript = [];
          utteranceMap.clear();

          fs.mkdirSync(SESSIONS_DIR, { recursive: true });
          startCapture(path.join(
            SESSIONS_DIR,
            `${recordingStartTime.toISOString().replace(/:/g, '-')}-frames`
          ));

          lastSeenBarcode = null;
          lastVisionHash = null;
          isRecording = true;
          console.log(`[${recordingStartTime.toISOString()}] Recording started`);
          confirm('Session started');
        }
        // Discard all other speech while idle
        return;
      }

      // ── RECORDING: watch for end command, else collect transcript ─────────
      if (wantsEnd) {
        utteranceBuffer.length = 0; // clear so the phrase can't re-trigger
        const endTime = new Date();

        stopCapture();
        isRecording = false;
        console.log(`[${endTime.toISOString()}] Recording stopped — ${frameIndex} frame(s) in ${framesDir}`);

        confirm('Session ended, saving');

        // Flush utteranceMap → transcript in insertion order
        for (const e of utteranceMap.values()) transcript.push(e);

        const record: SessionRecord = {
          sessionId,
          userId,
          startTime: recordingStartTime!.toISOString(),
          endTime: endTime.toISOString(),
          transcript,
        };

        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        const filename = path.join(
          SESSIONS_DIR,
          `${endTime.toISOString().replace(/:/g, '-')}.json`
        );
        fs.writeFileSync(filename, JSON.stringify(record, null, 2));
        console.log(`[${endTime.toISOString()}] Session saved → ${filename}`);

        // Snapshot framesDir before state could be mutated by a new start
        const savedFramesDir = framesDir;
        extractFromTranscript(filename).catch((e) =>
          console.error(`[${new Date().toISOString()}] Extraction failed:`, e)
        );
        processKeyframes(savedFramesDir).catch((e) =>
          console.error(`[${new Date().toISOString()}] Keyframe processing failed:`, e)
        );
        return;
      }

      // Normal transcript entry — store keyed by utteranceId for dedup
      const entry: TranscriptEntry = {
        timestamp: new Date().toISOString(),
        text,
        utteranceId: data.utteranceId,
        speakerId: data.speakerId,
        startTime: data.startTime,
        endTime: data.endTime,
      };

      if (data.utteranceId) {
        utteranceMap.set(data.utteranceId, entry);
      } else {
        transcript.push(entry);
      }
    });
  }
}

const app = new CompoundLoggerApp({
  packageName: 'com.senecal.pharmacycompounder',
  apiKey: process.env.MENTRA_API_KEY!,
  port: 3000,
});

// ── Web UI routes ─────────────────────────────────────────────────────────────
const express = app.getExpressApp();
const UI_HTML = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf-8');

// Serve the dashboard
express.get('/', (_req: Request, res: Response) => res.send(UI_HTML));

// List all sessions
express.get('/api/sessions', (_req: Request, res: Response) => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('-extraction.json'))
    .sort()
    .reverse();

  const sessions = files.map(f => {
    const id = f.replace(/\.json$/, '');
    const hasExtraction = fs.existsSync(path.join(SESSIONS_DIR, `${id}-extraction.json`));
    return { id, hasExtraction };
  });

  res.json(sessions);
});

// Return one session's transcript + extraction
express.get('/api/sessions/:id', (req: Request, res: Response) => {
  const id = req.params['id'];
  if (!id || id.includes('/') || id.includes('..')) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }

  const transcriptPath = path.join(SESSIONS_DIR, `${id}.json`);
  if (!fs.existsSync(transcriptPath)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
  const extractionPath = path.join(SESSIONS_DIR, `${id}-extraction.json`);
  const extraction = fs.existsSync(extractionPath)
    ? JSON.parse(fs.readFileSync(extractionPath, 'utf-8'))
    : null;

  res.json({ transcript, extraction });
});

// List frames for a session.
// Session IDs use endTime; frame dirs use startTime — we read the transcript to
// bridge them. Keyframes dir is preferred over raw frames if it has any JPEGs.
express.get('/api/sessions/:id/frames', (req: Request, res: Response) => {
  const id = req.params['id'];
  if (!id || id.includes('/') || id.includes('..')) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }

  const transcriptPath = path.join(SESSIONS_DIR, `${id}.json`);
  if (!fs.existsSync(transcriptPath)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const record = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as { startTime: string };
  const startSlug = record.startTime.replace(/:/g, '-');

  const keyframesDir = path.join(SESSIONS_DIR, `${startSlug}-keyframes`);
  const framesDir    = path.join(SESSIONS_DIR, `${startSlug}-frames`);

  // Load per-frame metadata from the keyframe manifest if present
  const manifestPath = path.join(keyframesDir, 'manifest.json');
  const metaByName: Record<string, Record<string, unknown>> = {};
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      frames: Array<{ filename: string } & Record<string, unknown>>;
    };
    for (const f of manifest.frames) metaByName[f.filename] = f;
  }

  // Prefer keyframes (filtered) over raw frames
  const hasKeyframes = fs.existsSync(keyframesDir) &&
    fs.readdirSync(keyframesDir).some(f => /\.(jpg|jpeg)$/i.test(f));
  const hasFrames = fs.existsSync(framesDir);

  let source: 'keyframes' | 'frames' | null = null;
  let sourceDir = '';
  if (hasKeyframes) { source = 'keyframes'; sourceDir = keyframesDir; }
  else if (hasFrames) { source = 'frames';    sourceDir = framesDir; }

  if (!source) {
    res.json({ source: null, startSlug, files: [] });
    return;
  }

  const files = fs.readdirSync(sourceDir)
    .filter(f => /\.(jpg|jpeg)$/i.test(f))
    .sort()
    .map(filename => ({ filename, ...(metaByName[filename] ?? {}) }));

  res.json({ source, startSlug, files });
});

// Serve a frame JPEG — checks keyframes dir first, then raw frames dir.
// Session ID → startTime (from transcript) → dir name.
express.get('/sessions/:id/frames/:filename', (req: Request, res: Response) => {
  const id       = req.params['id'] as string;
  const filename = req.params['filename'] as string;

  if (!id       || id.includes('/')       || id.includes('..') ||
      !filename  || filename.includes('/') || filename.includes('..') ||
      !/\.(jpg|jpeg)$/i.test(filename)) {
    res.status(400).send('Invalid request');
    return;
  }

  const transcriptPath = path.join(SESSIONS_DIR, `${id}.json`);
  if (!fs.existsSync(transcriptPath)) {
    res.status(404).send('Session not found');
    return;
  }

  const record = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as { startTime: string };
  const startSlug = record.startTime.replace(/:/g, '-');

  const candidates = [
    path.join(SESSIONS_DIR, `${startSlug}-keyframes`, filename),
    path.join(SESSIONS_DIR, `${startSlug}-frames`,    filename),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.sendFile(candidate);
      return;
    }
  }

  res.status(404).send('Frame not found');
});
// ─────────────────────────────────────────────────────────────────────────────

process.on('uncaughtException', (e) => console.error('CRASH:', e));
process.on('unhandledRejection', (e) => console.error('REJECT:', e));

console.log('About to start...');
app.start()
  .then(() => console.log('Compound Logger server running on port 3000'))
  .catch((e) => console.error('START FAILED:', e));
