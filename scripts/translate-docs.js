#!/usr/bin/env node
/**
 * scripts/translate-docs.js
 *
 * Multilingual Document Automation — Translation Script
 *
 * Reads newly added files from docs-incoming/, extracts their text content,
 * translates each piece of text via the Azure AI Translator REST API, then
 * rebuilds the translated documents and saves them to translations/<lang>/.
 * Finally it moves the originals to docs-processed/.
 *
 * Supported formats: DOCX, PPTX, XLSX, PDF
 *
 * Environment variables:
 *   AZURE_TRANSLATOR_KEY       — (GitHub Actions secret) Azure Cognitive Services subscription key
 *   AZURE_TRANSLATOR_ENDPOINT  — (GitHub Actions secret) e.g. https://api.cognitive.microsofttranslator.com
 *   AZURE_TRANSLATOR_REGION    — (GitHub Actions secret) e.g. eastus
 *   TARGET_LANGUAGES           — (GitHub Actions variable) comma-separated BCP-47 language codes, e.g. "en,zh,es"
 *   INCOMING_FILES             — (workflow-generated) newline-separated repo-relative paths of newly
 *                                pushed files, computed by the workflow via `git diff`
 */

import fs from 'fs/promises';
import path from 'path';
import { createReadStream } from 'fs';
import { fileURLToPath } from 'url';

// ── Dynamic imports for optional heavy dependencies ───────────────────────────
// These packages must be installed via npm ci before this script runs.
// We import them lazily so the script can at least start even if a dep is missing.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ── Configuration ─────────────────────────────────────────────────────────────

const {
  AZURE_TRANSLATOR_KEY,
  AZURE_TRANSLATOR_ENDPOINT = 'https://api.cognitive.microsofttranslator.com',
  AZURE_TRANSLATOR_REGION,
  TARGET_LANGUAGES = 'en,zh',
  // CUSTOM_LANGUAGE_CODE: when set, output for this BCP-47 code goes to
  // translations/third/ instead of translations/<code>/ to match the
  // repository folder convention defined in the problem specification.
  CUSTOM_LANGUAGE_CODE = '',
  INCOMING_FILES = '',
} = process.env;

const targetLanguages = TARGET_LANGUAGES.split(',')
  .map((l) => l.trim())
  .filter(Boolean);

/**
 * Map a BCP-47 language code to the output folder name under translations/.
 * If CUSTOM_LANGUAGE_CODE is set and matches the code, use the "third" folder.
 */
function outputFolder(langCode) {
  if (CUSTOM_LANGUAGE_CODE && langCode === CUSTOM_LANGUAGE_CODE) return 'third';
  return langCode;
}

// ── Azure Translator helper ───────────────────────────────────────────────────

/**
 * Translate an array of text strings to all target languages in one API call.
 * Returns an object keyed by language code, each value being an array of
 * translated strings in the same order as `texts`.
 *
 * @param {string[]} texts   - Array of source strings to translate
 * @param {string}   fromLang - BCP-47 source language code, e.g. "en"
 * @returns {Promise<Record<string, string[]>>}
 */
async function translateTexts(texts, fromLang = 'en') {
  if (!AZURE_TRANSLATOR_KEY) {
    throw new Error('AZURE_TRANSLATOR_KEY environment variable is not set.');
  }
  if (!AZURE_TRANSLATOR_REGION) {
    throw new Error('AZURE_TRANSLATOR_REGION environment variable is not set.');
  }

  // Filter out targets that match the source language
  const toLanguages = targetLanguages.filter((l) => l !== fromLang);
  if (toLanguages.length === 0) {
    // Nothing to translate — return the originals for each requested language
    const result = {};
    for (const lang of targetLanguages) {
      result[lang] = [...texts];
    }
    return result;
  }

  const url = new URL('/translate', AZURE_TRANSLATOR_ENDPOINT);
  url.searchParams.set('api-version', '3.0');
  url.searchParams.set('from', fromLang);
  toLanguages.forEach((lang) => url.searchParams.append('to', lang));

  // Chunk large arrays to stay within the Azure request size limit (~10 000 chars)
  const CHUNK_SIZE = 50;
  const chunks = [];
  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    chunks.push(texts.slice(i, i + CHUNK_SIZE));
  }

  // Map langCode -> array of translated strings
  const accumulated = {};
  for (const lang of toLanguages) {
    accumulated[lang] = [];
  }

  for (const chunk of chunks) {
    const body = chunk.map((text) => ({ Text: text }));
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_TRANSLATOR_KEY,
        'Ocp-Apim-Subscription-Region': AZURE_TRANSLATOR_REGION,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure Translator error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    // data is an array; each element corresponds to one input text
    for (const item of data) {
      for (const translation of item.translations) {
        accumulated[translation.to].push(translation.text);
      }
    }
  }

  // Also include the source language unchanged
  if (targetLanguages.includes(fromLang)) {
    accumulated[fromLang] = [...texts];
  }

  return accumulated;
}

// ── DOCX processing ───────────────────────────────────────────────────────────

/**
 * Process a DOCX file:
 *  1. Unzip the .docx archive
 *  2. Parse word/document.xml
 *  3. Extract all <w:t> text nodes (preserving structure)
 *  4. Translate
 *  5. Reinsert translated text
 *  6. Repack as a new .docx
 */
async function processDocx(inputPath, outputDir, fileName) {
  const { default: PizZip } = await import('pizzip');
  const { DOMParser, XMLSerializer } = await import('@xmldom/xmldom');

  const content = await fs.readFile(inputPath);
  const zip = new PizZip(content);

  const documentXml = zip.files['word/document.xml']?.asText();
  if (!documentXml) throw new Error('word/document.xml not found in DOCX');

  // Parse the XML
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const doc = parser.parseFromString(documentXml, 'text/xml');

  // Collect all <w:t> nodes
  const textNodes = doc.getElementsByTagName('w:t');
  const texts = [];
  for (let i = 0; i < textNodes.length; i++) {
    texts.push(textNodes[i].textContent || '');
  }

  if (texts.length === 0) {
    console.log(`  [DOCX] No text nodes found in ${fileName} — skipping`);
    return;
  }

  // Translate
  const translations = await translateTexts(texts);

  // Rebuild one file per language
  for (const [lang, translatedTexts] of Object.entries(translations)) {
    // Clone the original zip
    const outZip = new PizZip(content);
    const outDoc = parser.parseFromString(documentXml, 'text/xml');
    const outNodes = outDoc.getElementsByTagName('w:t');

    for (let i = 0; i < outNodes.length && i < translatedTexts.length; i++) {
      outNodes[i].textContent = translatedTexts[i];
    }

    const updatedXml = serializer.serializeToString(outDoc);
    outZip.file('word/document.xml', updatedXml);

    const outBuffer = outZip.generate({ type: 'nodebuffer' });
    const outPath = path.join(outputDir, outputFolder(lang), fileName);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, outBuffer);
    console.log(`  [DOCX] Written: ${outPath}`);
  }
}

// ── PPTX processing ───────────────────────────────────────────────────────────

/**
 * Process a PPTX file:
 *  1. Unzip
 *  2. Parse each ppt/slides/slideN.xml
 *  3. Extract all <a:t> text runs
 *  4. Translate
 *  5. Reinsert & repack
 */
async function processPptx(inputPath, outputDir, fileName) {
  const { default: PizZip } = await import('pizzip');
  const { DOMParser, XMLSerializer } = await import('@xmldom/xmldom');

  const content = await fs.readFile(inputPath);
  const zip = new PizZip(content);

  // Gather all slide XML files
  const slideKeys = Object.keys(zip.files).filter((k) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(k)
  );

  if (slideKeys.length === 0) {
    console.log(`  [PPTX] No slides found in ${fileName} — skipping`);
    return;
  }

  const parser = new DOMParser();
  const serializer = new XMLSerializer();

  // Collect (slideKey, nodeIndex, text) tuples
  const allTexts = [];
  const slideDocuments = {};

  for (const key of slideKeys) {
    const xml = zip.files[key].asText();
    const doc = parser.parseFromString(xml, 'text/xml');
    slideDocuments[key] = doc;
    const nodes = doc.getElementsByTagName('a:t');
    for (let i = 0; i < nodes.length; i++) {
      allTexts.push({ key, index: i, text: nodes[i].textContent || '' });
    }
  }

  if (allTexts.length === 0) {
    console.log(`  [PPTX] No text runs found in ${fileName} — skipping`);
    return;
  }

  const translations = await translateTexts(allTexts.map((t) => t.text));

  for (const [lang, translatedTexts] of Object.entries(translations)) {
    const outZip = new PizZip(content);

    // Rebuild each slide
    const slideDocs = {};
    for (const key of slideKeys) {
      const xml = zip.files[key].asText();
      slideDocs[key] = parser.parseFromString(xml, 'text/xml');
    }

    allTexts.forEach(({ key, index }, i) => {
      const nodes = slideDocs[key].getElementsByTagName('a:t');
      if (nodes[index]) {
        nodes[index].textContent = translatedTexts[i] ?? nodes[index].textContent;
      }
    });

    for (const key of slideKeys) {
      outZip.file(key, serializer.serializeToString(slideDocs[key]));
    }

    const outBuffer = outZip.generate({ type: 'nodebuffer' });
    const outPath = path.join(outputDir, outputFolder(lang), fileName);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, outBuffer);
    console.log(`  [PPTX] Written: ${outPath}`);
  }
}

// ── XLSX processing ───────────────────────────────────────────────────────────

/**
 * Process an XLSX file:
 *  1. Unzip
 *  2. Parse xl/sharedStrings.xml
 *  3. Extract all <si><t> string items
 *  4. Translate
 *  5. Reinsert & repack
 */
async function processXlsx(inputPath, outputDir, fileName) {
  const { default: PizZip } = await import('pizzip');
  const { DOMParser, XMLSerializer } = await import('@xmldom/xmldom');

  const content = await fs.readFile(inputPath);
  const zip = new PizZip(content);

  const sharedStringsKey = 'xl/sharedStrings.xml';
  if (!zip.files[sharedStringsKey]) {
    console.log(`  [XLSX] No sharedStrings.xml in ${fileName} — skipping`);
    return;
  }

  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const xml = zip.files[sharedStringsKey].asText();
  const doc = parser.parseFromString(xml, 'text/xml');
  const tNodes = doc.getElementsByTagName('t');

  const texts = [];
  for (let i = 0; i < tNodes.length; i++) {
    texts.push(tNodes[i].textContent || '');
  }

  if (texts.length === 0) {
    console.log(`  [XLSX] No text entries in ${fileName} — skipping`);
    return;
  }

  const translations = await translateTexts(texts);

  for (const [lang, translatedTexts] of Object.entries(translations)) {
    const outZip = new PizZip(content);
    const outDoc = parser.parseFromString(xml, 'text/xml');
    const outNodes = outDoc.getElementsByTagName('t');

    for (let i = 0; i < outNodes.length && i < translatedTexts.length; i++) {
      outNodes[i].textContent = translatedTexts[i];
    }

    outZip.file(sharedStringsKey, serializer.serializeToString(outDoc));

    const outBuffer = outZip.generate({ type: 'nodebuffer' });
    const outPath = path.join(outputDir, outputFolder(lang), fileName);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, outBuffer);
    console.log(`  [XLSX] Written: ${outPath}`);
  }
}

// ── PDF processing ────────────────────────────────────────────────────────────

/**
 * Process a PDF file:
 *  1. Extract text with pdf-parse
 *  2. Translate
 *  3. Save translated text as plain-text .txt files
 *     (PDF rebuilding requires a full rendering engine; text output is pragmatic)
 */
async function processPdf(inputPath, outputDir, fileName) {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');

  const buffer = await fs.readFile(inputPath);
  const data = await pdfParse(buffer);
  const text = data.text;

  if (!text || text.trim().length === 0) {
    console.log(`  [PDF] No extractable text in ${fileName} — skipping`);
    return;
  }

  // Split into paragraphs to stay within Azure request limits
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const translations = await translateTexts(paragraphs);

  const baseName = fileName.replace(/\.pdf$/i, '');

  for (const [lang, translatedParagraphs] of Object.entries(translations)) {
    const outPath = path.join(outputDir, outputFolder(lang), `${baseName}.txt`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, translatedParagraphs.join('\n\n'), 'utf8');
    console.log(`  [PDF]  Written: ${outPath}`);
  }
}

// ── File router ───────────────────────────────────────────────────────────────

const PROCESSORS = {
  '.docx': processDocx,
  '.pptx': processPptx,
  '.xlsx': processXlsx,
  '.pdf': processPdf,
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const incomingDir = path.join(ROOT, 'docs-incoming');
  const processedDir = path.join(ROOT, 'docs-processed');
  const translationsDir = path.join(ROOT, 'translations');

  // Determine which files to process
  const incomingFiles = INCOMING_FILES.split('\n')
    .map((f) => f.trim())
    .filter((f) => f && !f.endsWith('.gitkeep'));

  if (incomingFiles.length === 0) {
    console.log('No incoming files detected. Exiting.');
    return;
  }

  console.log(`Processing ${incomingFiles.length} file(s) into ${targetLanguages.join(', ')} …`);

  // Ensure output directories exist. For any language mapped to "third/" we
  // create both the "third/" folder and any folder named after the code itself.
  const uniqueOutputFolders = [
    ...new Set(targetLanguages.map(outputFolder)),
  ];
  await Promise.all([
    fs.mkdir(processedDir, { recursive: true }),
    ...uniqueOutputFolders.map((folder) =>
      fs.mkdir(path.join(translationsDir, folder), { recursive: true })
    ),
  ]);

  for (const repoRelativePath of incomingFiles) {
    const filePath = path.join(ROOT, repoRelativePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();

    console.log(`\nProcessing: ${fileName} (${ext})`);

    const processor = PROCESSORS[ext];
    if (!processor) {
      console.warn(`  Unsupported file type "${ext}" — skipping ${fileName}`);
      continue;
    }

    try {
      await processor(filePath, translationsDir, fileName);

      // Move original to docs-processed/
      const destPath = path.join(processedDir, fileName);
      await fs.rename(filePath, destPath);
      console.log(`  Moved original to: ${destPath}`);
    } catch (err) {
      console.error(`  ERROR processing ${fileName}: ${err.message}`);
      // Continue with remaining files rather than aborting the whole job
    }
  }

  console.log('\nTranslation pipeline complete.');
}

main().catch((err) => {
  console.error('Fatal error in translation script:', err);
  process.exit(1);
});
