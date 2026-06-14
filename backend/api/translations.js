import { randomUUID } from 'crypto';
import { loadLicenses, saveLicenses } from '../lib/storage.js';
import {
  storeTranslationAssets,
  listTranslationsForLanguage,
  getTranslationMetadata,
  getTranslationFileBuffer,
} from '../lib/user-storage.js';
import { resolveLicenseFromBearer } from './validate-license.js';

const AZURE_TRANSLATOR_KEY = process.env.AZURE_TRANSLATOR_KEY || '';
const AZURE_TRANSLATOR_REGION = process.env.AZURE_TRANSLATOR_REGION || '';
const AZURE_TRANSLATOR_ENDPOINT = process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.markdown', '.rst', '.tex', '.rtf',
  '.html', '.htm', '.xhtml', '.xml', '.svg',
  '.css', '.scss', '.sass', '.less',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env', '.csv', '.tsv',
  '.js', '.ts', '.jsx', '.tsx', '.vue', '.svelte',
  '.py', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rs', '.swift', '.kt', '.kts',
  '.sh', '.bash', '.zsh', '.ps1', '.lua', '.pl', '.r', '.scala', '.dart',
  '.sql', '.log',
]);

function isLikelyText(mimeType, fileName) {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(fileName || '').toLowerCase();

  if (mime.startsWith('text/')) return true;
  if (mime.includes('json') || mime.includes('xml') || mime.includes('yaml')) return true;

  const ext = '.' + name.split('.').pop();
  return TEXT_EXTENSIONS.has(ext);
}

async function translateText(text, targetLanguage, fromLanguage = '') {
  if (!AZURE_TRANSLATOR_KEY || !AZURE_TRANSLATOR_REGION) {
    throw new Error('Azure Translator is not configured. Set AZURE_TRANSLATOR_KEY and AZURE_TRANSLATOR_REGION.');
  }

  const fromParam = fromLanguage ? `&from=${encodeURIComponent(fromLanguage)}` : '';
  const endpoint = `${AZURE_TRANSLATOR_ENDPOINT.replace(/\/$/, '')}/translate?api-version=3.0&to=${encodeURIComponent(targetLanguage)}${fromParam}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': AZURE_TRANSLATOR_KEY,
      'Ocp-Apim-Subscription-Region': AZURE_TRANSLATOR_REGION,
    },
    body: JSON.stringify([{ text }]),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || 'Azure Translator request failed.');
  }

  const payload = await response.json();
  return String(payload?.[0]?.translations?.[0]?.text || '');
}

function normalizeTranslationMeta(meta) {
  return {
    id: String(meta?.id || ''),
    fileName: String(meta?.fileName || ''),
    targetLanguage: String(meta?.targetLanguage || ''),
    org: String(meta?.org || ''),
    createdAt: String(meta?.createdAt || new Date().toISOString()),
    outputKey: String(meta?.outputKey || ''),
    inputBytes: Number(meta?.inputBytes || 0),
    outputBytes: Number(meta?.outputBytes || 0),
    charactersCharged: Number(meta?.charactersCharged || 0),
  };
}

async function incrementLicenseUsage(licenseKey, additionalRequests, additionalCharacters) {
  const { json: licenses, etag } = await loadLicenses();
  if (!Array.isArray(licenses)) {
    throw new Error('licenses.json must be an array');
  }

  const index = licenses.findIndex((item) => item?.key === licenseKey);
  if (index === -1) {
    throw new Error('License not found during usage update.');
  }

  licenses[index].requests = Number(licenses[index].requests || 0) + Number(additionalRequests || 0);
  licenses[index].characters = Number(licenses[index].characters || 0) + Number(additionalCharacters || 0);

  await saveLicenses(licenses, etag, `usage update for ${licenses[index].org || 'org'}`);
  return licenses[index];
}

export async function translateHandler(req, res) {
  try {
    const resolved = await resolveLicenseFromBearer(req);
    if (!resolved.valid || !resolved.record) {
      return res.status(401).json({ ok: false, error: resolved.reason || 'invalid-license' });
    }

    const { fileName, base64Content, targetLanguage = 'en', fromLanguage = '', mimeType = 'application/octet-stream' } = req.body || {};
    if (!fileName || !base64Content || !targetLanguage) {
      return res.status(400).json({ ok: false, error: 'fileName, base64Content, and targetLanguage are required.' });
    }

    const inputBuffer = Buffer.from(base64Content, 'base64');
    const isTextFile = isLikelyText(mimeType, fileName);

    let outputBuffer = inputBuffer;
    if (isTextFile && process.env.MDAS_ENV !== 'dev') {
      const inputText = inputBuffer.toString('utf8');
      const translatedText = await translateText(inputText, targetLanguage, fromLanguage);
      outputBuffer = Buffer.from(translatedText, 'utf8');
    }

    const translationId = randomUUID();
    const charactersCharged = isTextFile ? inputBuffer.length : 0;
    const usageRecord = await incrementLicenseUsage(resolved.licenseKey, 1, charactersCharged);

    const stored = await storeTranslationAssets({
      org: usageRecord.org,
      translationId,
      targetLanguage,
      fileName,
      inputBuffer,
      outputBuffer,
      metadata: {
        mimeType,
        mode: isTextFile ? 'azure-text-translation' : 'binary-pass-through',
        inputBytes: inputBuffer.length,
        outputBytes: outputBuffer.length,
        charactersCharged,
      },
    });

    return res.status(200).json({
      ok: true,
      translationId,
      metadataKey: stored.metadataKey,
      outputKey: stored.outputKey,
      fileName,
      targetLanguage,
      usage: {
        requests: Number(usageRecord.requests || 0),
        limit: Number(usageRecord.limit || 0),
        characters: Number(usageRecord.characters || 0),
        charLimit: Number(usageRecord.charLimit || 0),
      },
      content: outputBuffer.toString('base64'),
      encoding: 'base64',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Translation failed.' });
  }
}

export async function listTranslationsHandler(req, res) {
  try {
    const resolved = await resolveLicenseFromBearer(req);
    if (!resolved.valid || !resolved.record) {
      return res.status(401).json({ ok: false, error: resolved.reason || 'invalid-license' });
    }

    const lang = String(req.query.lang || 'en').trim();
    const items = await listTranslationsForLanguage(resolved.record.org, lang);

    return res.status(200).json({
      ok: true,
      items: items.map((item) => normalizeTranslationMeta(item)),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to list translations.' });
  }
}

export async function getTranslationHandler(req, res) {
  try {
    const resolved = await resolveLicenseFromBearer(req);
    if (!resolved.valid || !resolved.record) {
      return res.status(401).json({ ok: false, error: resolved.reason || 'invalid-license' });
    }

    const id = String(req.params.id || '');
    const lang = String(req.query.lang || '').trim();
    if (!id || !lang) {
      return res.status(400).json({ ok: false, error: 'translation id and lang are required.' });
    }

    const metadata = await getTranslationMetadata(resolved.record.org, lang, id);
    return res.status(200).json({ ok: true, item: normalizeTranslationMeta(metadata) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to load translation metadata.' });
  }
}

export async function getTranslationFileHandler(req, res) {
  try {
    const resolved = await resolveLicenseFromBearer(req);
    if (!resolved.valid || !resolved.record) {
      return res.status(401).json({ ok: false, error: resolved.reason || 'invalid-license' });
    }

    const id = String(req.params.id || '');
    const lang = String(req.query.lang || '').trim();
    if (!id || !lang) {
      return res.status(400).json({ ok: false, error: 'translation id and lang are required.' });
    }

    const metadata = await getTranslationMetadata(resolved.record.org, lang, id);
    const { buffer, contentType } = await getTranslationFileBuffer(metadata.outputKey);

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${metadata.fileName}"`);
    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to load translation output file.' });
  }
}
