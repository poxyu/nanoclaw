import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const envConfig = readEnvFile(['WHISPER_BIN', 'WHISPER_MODEL', 'WHISPER_THREADS']);

const WHISPER_BIN = process.env.WHISPER_BIN || envConfig.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  envConfig.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-medium.bin');
// Use half the available cores — leaves headroom for the rest of the system
const WHISPER_THREADS =
  process.env.WHISPER_THREADS ||
  envConfig.WHISPER_THREADS ||
  String(Math.max(1, Math.floor(os.cpus().length / 2)));

/**
 * Convert an audio file to 16 kHz mono WAV (whisper.cpp requirement).
 * Returns the path to the temporary WAV file.
 */
async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, '') + '.wav';
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-ar', '16000',    // 16 kHz sample rate (whisper requirement)
    '-ac', '1',        // mono
    '-c:a', 'pcm_s16le',
    '-y',              // overwrite
    wavPath,
  ], { timeout: 30_000 });
  return wavPath;
}

/**
 * Transcribe an audio file using whisper.cpp.
 * Accepts any format ffmpeg can decode (ogg, mp3, m4a, wav, etc.).
 * Returns the transcribed text, or null on failure.
 */
export async function transcribeAudio(audioPath: string): Promise<string | null> {
  let wavPath: string | null = null;
  try {
    // Convert to WAV for whisper.cpp
    wavPath = await convertToWav(audioPath);

    const { stdout, stderr } = await execFileAsync(WHISPER_BIN, [
      '--model', WHISPER_MODEL,
      '--language', 'auto',      // auto-detect Russian/English
      '--threads', WHISPER_THREADS,
      '--beam-size', '5',        // beam search for best quality
      '--best-of', '5',          // evaluate 5 candidates per step
      '--no-timestamps',         // clean output without [00:00.000 --> ...]
      '--no-prints',             // suppress everything except the transcript
      '--flash-attn',            // faster attention on CPU
      '--file', wavPath,
    ], { timeout: 120_000 });    // 2 min timeout for long messages

    const transcript = stdout.trim();
    if (!transcript) {
      logger.warn({ audioPath, stderr: stderr.slice(0, 500) }, 'Whisper returned empty transcript');
      return null;
    }

    logger.info(
      { audioPath, chars: transcript.length, threads: WHISPER_THREADS },
      'Voice message transcribed',
    );
    return transcript;
  } catch (err: any) {
    logger.error({ err: err.message, audioPath }, 'Voice transcription failed');
    return null;
  } finally {
    // Clean up temp files
    if (wavPath) fs.promises.unlink(wavPath).catch(() => {});
    fs.promises.unlink(audioPath).catch(() => {});
  }
}

/**
 * Download a file from a URL to a temp path.
 */
export async function downloadToTemp(url: string, ext: string): Promise<string> {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `nanoclaw-voice-${Date.now()}${ext}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(tmpFile, buffer);
  return tmpFile;
}
