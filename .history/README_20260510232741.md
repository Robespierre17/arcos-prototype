
# LATEST UPDATE > ## Project Pause Note (May 2026)

Arcos AI is a smart glasses application for documenting sterile IV compounding in hospital pharmacy. A working prototype was built on Mentra Live glasses using the MentraOS SDK, integrating voice narration, photo capture, keyframe filtering, Claude Vision for label reading, ZXing for barcode detection, LLM-based structured extraction, and TTS confirmation, with a dashboard at localhost:3000. Letters of interest were collected from Beth Israel, NYP, and Dana Farber in 2025. Architectural decisions included MentraOS built-in transcription, 2-second photo capture intervals (an SDK limitation), and a deterministic rules engine for safety checks. The project is paused — not abandoned. Key reasons: HIPAA compliance, provisional patent filing, and the need for a co-founder. I have a chief medical officer who can occasionally contribute, but I need someone able to share the build alongside me. The technical scaffolding is intact.






# mentra-prototype

Arcos AI pharmacy compounding prototype for [Mentra](https://mentra.glass) smart glasses. Voice-activated session capture with real-time NDC barcode recognition and label transcription.

## What it does

While worn, the glasses listen for voice commands and capture the compounding workflow:

- **"Arcos start session"** — begins recording transcript and capturing a photo every ~2 s.
- **"Arcos end session"** — stops capture, saves the session, runs post-processing.

During a session, each frame is run through a two-stage label reader:

1. **ZXing** (local, fast) reads any barcode it can find. New NDCs are spoken back via TTS (`"<drug name> confirmed"` or `"Unknown compound, N D C ..."`).
2. **Claude Vision** (remote, paid) is only called when ZXing finds nothing *and* the frame is visually distinct from the last one sent to Vision (dHash Hamming distance > 10). It can recover both barcodes and printed drug names.

TTS is queued during active speech and flushed after a 3 s silence gap so it doesn't talk over the user. Short echo phrases are filtered out of the transcript.

## Layout

```
src/
  index.ts          AppServer entry; session state machine, voice commands, capture loop
  extract.ts        Post-session transcript → structured compound record (Claude)
  vision.ts         Single-frame label analysis (Claude Vision)
  keyframes.ts      ZXing barcode reader + dHash for frame deduplication
  ndc-lookup.ts     NDC → drug name lookup
  generate-labels.ts  Renders labels.html from session data
sessions/           Per-session frames + transcript JSON (gitignored)
```

## Setup

```bash
npm install
cp .env.example .env   # if present; otherwise create .env with the keys below
npm start
```

Required env vars:

- `MENTRA_API_KEY` — Mentra app key
- `ANTHROPIC_API_KEY` — Claude API key (Vision + transcript extraction)

Runs with `tsx` directly from TypeScript — no build step.

## Notes

- `sessions/` and `node_modules/` are gitignored; frames and transcripts stay local.
- The Mentra SDK has no local video recording — the 2 s photo cadence is the only capture path.
- See the long comment at the top of `src/index.ts` for SDK capability notes.
