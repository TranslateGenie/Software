import { randomUUID } from 'crypto';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
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

async function callAzureTranslate(texts, targetLanguage, fromLanguage = '') {
  if (!AZURE_TRANSLATOR_KEY || !AZURE_TRANSLATOR_REGION) {
    throw new Error('Azure Translator is not configured. Set AZURE_TRANSLATOR_KEY and AZURE_TRANSLATOR_REGION.');
  }

  const fromParam = fromLanguage ? `&from=${encodeURIComponent(fromLanguage)}` : '';
  const base = AZURE_TRANSLATOR_ENDPOINT.replace(/\/$/, '');
  const path = base.includes('cognitiveservices.azure.com')
    ? '/translator/text/v3.0/translate'
    : '/translate';
  const endpoint = `${base}${path}?api-version=3.0&to=${encodeURIComponent(targetLanguage)}${fromParam}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': AZURE_TRANSLATOR_KEY,
      'Ocp-Apim-Subscription-Region': AZURE_TRANSLATOR_REGION,
    },
    body: JSON.stringify(texts.map((t) => ({ text: t }))),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || 'Azure Translator request failed.');
  }

  const payload = await response.json();
  return payload.map((item) => String(item?.translations?.[0]?.text || ''));
}

async function translateText(text, targetLanguage, fromLanguage = '') {
  const results = await callAzureTranslate([text], targetLanguage, fromLanguage);
  return results[0];
}

async function translateDocx(inputBuffer, targetLanguage, fromLanguage) {
  const zip = new PizZip(inputBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Invalid DOCX: word/document.xml not found.');

  const xmlStr = docFile.asText();
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');

  const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paragraphs = Array.from(doc.getElementsByTagNameNS(NS, 'p'));

  const paraData = paragraphs
    .map((para) => {
      const tNodes = Array.from(para.getElementsByTagNameNS(NS, 't'));
      const text = tNodes.map((n) => n.textContent || '').join('');
      return { tNodes, text };
    })
    .filter((p) => p.text.trim());

  if (paraData.length === 0) return inputBuffer;

  // Azure supports up to 100 text elements per request
  const BATCH = 100;
  const translations = [];
  for (let i = 0; i < paraData.length; i += BATCH) {
    const chunk = paraData.slice(i, i + BATCH).map((p) => p.text);
    const results = await callAzureTranslate(chunk, targetLanguage, fromLanguage);
    translations.push(...results);
  }

  // Write translated text back — first <w:t> gets the full paragraph translation, rest are cleared
  paraData.forEach(({ tNodes }, idx) => {
    if (tNodes.length === 0) return;
    tNodes[0].textContent = translations[idx] ?? '';
    for (let j = 1; j < tNodes.length; j++) tNodes[j].textContent = '';
  });

  const serializer = new XMLSerializer();
  zip.file('word/document.xml', serializer.serializeToString(doc));
  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
}

async function translatePptx(inputBuffer, targetLanguage, fromLanguage) {
  const zip = new PizZip(inputBuffer);
  const NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();

  if (slideFiles.length === 0) return inputBuffer;

  const parser = new DOMParser();
  const slideData = slideFiles.map((name) => {
    const doc = parser.parseFromString(zip.file(name).asText(), 'application/xml');
    const paraData = Array.from(doc.getElementsByTagNameNS(NS, 'p'))
      .map((para) => {
        const tNodes = Array.from(para.getElementsByTagNameNS(NS, 't'));
        return { tNodes, text: tNodes.map((n) => n.textContent || '').join('') };
      })
      .filter((p) => p.text.trim());
    return { name, doc, paraData };
  });

  const allParas = slideData.flatMap((s) => s.paraData);
  if (allParas.length === 0) return inputBuffer;

  const BATCH = 100;
  const translations = [];
  for (let i = 0; i < allParas.length; i += BATCH) {
    translations.push(...await callAzureTranslate(allParas.slice(i, i + BATCH).map((p) => p.text), targetLanguage, fromLanguage));
  }

  let offset = 0;
  const serializer = new XMLSerializer();
  for (const { name, doc, paraData } of slideData) {
    paraData.forEach(({ tNodes }) => {
      if (!tNodes.length) return;
      tNodes[0].textContent = translations[offset++] ?? '';
      for (let j = 1; j < tNodes.length; j++) tNodes[j].textContent = '';
    });
    zip.file(name, serializer.serializeToString(doc));
  }

  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
}

async function translateXlsx(inputBuffer, targetLanguage, fromLanguage) {
  const zip = new PizZip(inputBuffer);
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (!ssFile) return inputBuffer;

  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const parser = new DOMParser();
  const doc = parser.parseFromString(ssFile.asText(), 'application/xml');

  const siData = Array.from(doc.getElementsByTagNameNS(NS, 'si'))
    .map((si) => {
      const tNodes = Array.from(si.getElementsByTagNameNS(NS, 't'));
      return { tNodes, text: tNodes.map((n) => n.textContent || '').join('') };
    })
    .filter((s) => s.text.trim());

  if (siData.length === 0) return inputBuffer;

  const BATCH = 100;
  const translations = [];
  for (let i = 0; i < siData.length; i += BATCH) {
    translations.push(...await callAzureTranslate(siData.slice(i, i + BATCH).map((s) => s.text), targetLanguage, fromLanguage));
  }

  siData.forEach(({ tNodes }, idx) => {
    if (!tNodes.length) return;
    tNodes[0].textContent = translations[idx] ?? '';
    for (let j = 1; j < tNodes.length; j++) tNodes[j].textContent = '';
  });

  zip.file('xl/sharedStrings.xml', new XMLSerializer().serializeToString(doc));
  return Buffer.from(zip.generate({ type: 'nodebuffer' }));
}

async function translateSubtitleBlocks(text, targetLanguage, fromLanguage, skipBlock) {
  const blocks = text.split(/\r?\n\r?\n/);

  const cueData = [];
  const parsedBlocks = blocks.map((block) => {
    if (skipBlock?.(block)) return { type: 'other', raw: block };
    const lines = block.split(/\r?\n/);
    const tsIndex = lines.findIndex((l) => l.includes('-->'));
    if (tsIndex === -1) return { type: 'other', raw: block };
    const textLines = lines.slice(tsIndex + 1).filter((l) => l.trim());
    if (textLines.length === 0) return { type: 'other', raw: block };
    const cueIdx = cueData.length;
    cueData.push({ text: textLines.join('\n'), lines, tsIndex });
    return { type: 'cue', cueIdx, lines, tsIndex };
  });

  if (cueData.length === 0) return Buffer.from(text, 'utf8');

  const BATCH = 100;
  const translations = [];
  for (let i = 0; i < cueData.length; i += BATCH) {
    translations.push(...await callAzureTranslate(cueData.slice(i, i + BATCH).map((c) => c.text), targetLanguage, fromLanguage));
  }

  const output = parsedBlocks.map((pb) => {
    if (pb.type === 'other') return pb.raw;
    const header = pb.lines.slice(0, pb.tsIndex + 1);
    return [...header, translations[pb.cueIdx]].join('\n');
  });

  return Buffer.from(output.join('\n\n'), 'utf8');
}

async function translateSrt(inputBuffer, targetLanguage, fromLanguage) {
  return translateSubtitleBlocks(inputBuffer.toString('utf8'), targetLanguage, fromLanguage);
}

async function translateVtt(inputBuffer, targetLanguage, fromLanguage) {
  return translateSubtitleBlocks(inputBuffer.toString('utf8'), targetLanguage, fromLanguage, (block) => {
    const t = block.trim();
    return t === 'WEBVTT' || t.startsWith('WEBVTT ') || t.startsWith('NOTE') || t.startsWith('STYLE') || t.startsWith('REGION');
  });
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
    const nameLower = fileName.toLowerCase();
    const isDocx = nameLower.endsWith('.docx') || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isPptx = nameLower.endsWith('.pptx') || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    const isXlsx = nameLower.endsWith('.xlsx') || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const isSrt  = nameLower.endsWith('.srt');
    const isVtt  = nameLower.endsWith('.vtt');
    const isTextFile = isLikelyText(mimeType, fileName);

    let outputBuffer = inputBuffer;
    let mode = 'binary-pass-through';
    let charactersCharged = 0;

    if (AZURE_TRANSLATOR_KEY) {
      if (isDocx) {
        outputBuffer = await translateDocx(inputBuffer, targetLanguage, fromLanguage);
        mode = 'docx-translation';
        charactersCharged = inputBuffer.length;
      } else if (isPptx) {
        outputBuffer = await translatePptx(inputBuffer, targetLanguage, fromLanguage);
        mode = 'pptx-translation';
        charactersCharged = inputBuffer.length;
      } else if (isXlsx) {
        outputBuffer = await translateXlsx(inputBuffer, targetLanguage, fromLanguage);
        mode = 'xlsx-translation';
        charactersCharged = inputBuffer.length;
      } else if (isSrt) {
        outputBuffer = await translateSrt(inputBuffer, targetLanguage, fromLanguage);
        mode = 'srt-translation';
        charactersCharged = inputBuffer.length;
      } else if (isVtt) {
        outputBuffer = await translateVtt(inputBuffer, targetLanguage, fromLanguage);
        mode = 'vtt-translation';
        charactersCharged = inputBuffer.length;
      } else if (isTextFile) {
        const inputText = inputBuffer.toString('utf8');
        const translatedText = await translateText(inputText, targetLanguage, fromLanguage);
        outputBuffer = Buffer.from(translatedText, 'utf8');
        mode = 'azure-text-translation';
        charactersCharged = inputBuffer.length;
      }
    }

    const translationId = randomUUID();
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
        mode,
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
