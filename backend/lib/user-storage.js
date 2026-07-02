/**
 * user-storage.js — Local filesystem storage for user translation files.
 * Always writes to MDAS_USER_DATA_DIR (the Electron userData path passed from
 * main.js at startup). Never touches S3 — user documents stay on-device.
 */

import path from 'path';
import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';

const userDataDir = process.env.MDAS_USER_DATA_DIR
  ?? path.join(process.cwd(), 'user-data');

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function storeTranslationAssets({
  org,
  translationId,
  targetLanguage,
  fileName,
  inputBuffer,
  outputBuffer,
  sidecar,
  metadata,
}) {
  const safeName = String(fileName || 'document.txt');

  const relOutputKey  = path.join('translations', 'output',  org, targetLanguage, translationId, safeName).replace(/\\/g, '/');
  const relMetaKey    = path.join('translations', 'meta',    org, targetLanguage, `${translationId}.json`).replace(/\\/g, '/');
  const relInputKey   = path.join('translations', 'input',   org, targetLanguage, translationId, safeName).replace(/\\/g, '/');
  const relSidecarKey = path.join('translations', 'sidecar', org, targetLanguage, `${translationId}.json`).replace(/\\/g, '/');

  const outDir  = path.join(userDataDir, 'translations', 'output', org, targetLanguage, translationId);
  const metaDir = path.join(userDataDir, 'translations', 'meta',   org, targetLanguage);

  await ensureDir(outDir);
  await ensureDir(metaDir);

  await writeFile(path.join(outDir, safeName), outputBuffer);

  // Persist the original + a translation-memory sidecar so the paid "Format With AI" reformat can
  // re-place translations into a DI-reconstructed layout without re-running translation. Only when
  // provided (PDF translations) — other formats don't get a sidecar.
  let inputKey;
  let sidecarKey;
  if (inputBuffer) {
    await ensureDir(path.join(userDataDir, 'translations', 'input', org, targetLanguage, translationId));
    await writeFile(path.join(userDataDir, relInputKey), inputBuffer);
    inputKey = relInputKey;
  }
  if (sidecar) {
    await ensureDir(path.join(userDataDir, 'translations', 'sidecar', org, targetLanguage));
    await writeFile(path.join(userDataDir, relSidecarKey), JSON.stringify(sidecar));
    sidecarKey = relSidecarKey;
  }

  const meta = {
    id: translationId,
    org,
    targetLanguage,
    fileName: safeName,
    outputKey: relOutputKey,
    ...(inputKey ? { inputKey } : {}),
    ...(sidecarKey ? { sidecarKey } : {}),
    createdAt: new Date().toISOString(),
    ...metadata,
  };

  await writeFile(path.join(metaDir, `${translationId}.json`), JSON.stringify(meta, null, 2));

  return {
    inputKey,
    outputKey:   relOutputKey,
    metadataKey: relMetaKey,
    sidecarKey,
  };
}

// Overwrites just the metadata JSON for an existing translation (e.g. to record a
// formattedOutputKey after an AI reformat) without disturbing the stored assets.
export async function updateTranslationMetadata(org, targetLanguage, translationId, patch) {
  const metaPath = path.join(userDataDir, 'translations', 'meta', org, targetLanguage, `${translationId}.json`);
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const next = { ...meta, ...patch };
  await writeFile(metaPath, JSON.stringify(next, null, 2));
  return next;
}

export async function getTranslationMetadata(org, targetLanguage, translationId) {
  const metaPath = path.join(userDataDir, 'translations', 'meta', org, targetLanguage, `${translationId}.json`);
  const raw = await readFile(metaPath, 'utf8');
  return JSON.parse(raw);
}

export async function listTranslationsForLanguage(org, targetLanguage) {
  const dir = path.join(userDataDir, 'translations', 'meta', org, targetLanguage);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const metas = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const raw = await readFile(path.join(dir, f), 'utf8');
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
  );

  return metas
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function clearTranslationsForLanguage(org, targetLanguage) {
  const dirs = ['meta', 'output', 'input', 'sidecar'].map(
    (kind) => path.join(userDataDir, 'translations', kind, org, targetLanguage),
  );
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function getTranslationFileBuffer(outputKey) {
  const filePath = path.join(userDataDir, outputKey);
  const buffer = await readFile(filePath);
  return { buffer, contentType: 'application/octet-stream' };
}

// Writes a buffer to a relative translation key (e.g. a polished output or an updated sidecar),
// creating parent directories as needed.
export async function writeTranslationFile(relKey, buffer) {
  const filePath = path.join(userDataDir, relKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
}
