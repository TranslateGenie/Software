/**
 * user-storage.js — Local filesystem storage for user translation files.
 * Always writes to MDAS_USER_DATA_DIR (the Electron userData path passed from
 * main.js at startup). Never touches S3 — user documents stay on-device.
 */

import path from 'path';
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
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
  outputBuffer,
  metadata,
}) {
  const safeName = String(fileName || 'document.txt');

  const relOutputKey = path.join('translations', 'output', org, targetLanguage, translationId, safeName).replace(/\\/g, '/');
  const relMetaKey   = path.join('translations', 'meta',   org, targetLanguage, `${translationId}.json`).replace(/\\/g, '/');

  const outDir  = path.join(userDataDir, 'translations', 'output', org, targetLanguage, translationId);
  const metaDir = path.join(userDataDir, 'translations', 'meta',   org, targetLanguage);

  await ensureDir(outDir);
  await ensureDir(metaDir);

  await writeFile(path.join(outDir, safeName), outputBuffer);

  const meta = {
    id: translationId,
    org,
    targetLanguage,
    fileName: safeName,
    outputKey: relOutputKey,
    createdAt: new Date().toISOString(),
    ...metadata,
  };

  await writeFile(path.join(metaDir, `${translationId}.json`), JSON.stringify(meta, null, 2));

  return {
    inputKey:    `translations/input/${org}/${translationId}/${safeName}`,
    outputKey:   relOutputKey,
    metadataKey: relMetaKey,
  };
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

export async function getTranslationFileBuffer(outputKey) {
  const filePath = path.join(userDataDir, outputKey);
  const buffer = await readFile(filePath);
  return { buffer, contentType: 'application/octet-stream' };
}
