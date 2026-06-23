import { randomUUID } from 'crypto';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { loadLicenses, saveLicenses } from '../lib/storage.js';
import {
  storeTranslationAssets,
  listTranslationsForLanguage,
  getTranslationMetadata,
  getTranslationFileBuffer,
  clearTranslationsForLanguage,
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

async function callAzureTranslate(texts, targetLanguage, fromLanguage = '', textType = 'plain') {
  if (!AZURE_TRANSLATOR_KEY || !AZURE_TRANSLATOR_REGION) {
    throw new Error('Azure Translator is not configured. Set AZURE_TRANSLATOR_KEY and AZURE_TRANSLATOR_REGION.');
  }

  const fromParam = fromLanguage ? `&from=${encodeURIComponent(fromLanguage)}` : '';
  const base = AZURE_TRANSLATOR_ENDPOINT.replace(/\/$/, '');
  const path = base.includes('cognitiveservices.azure.com')
    ? '/translator/text/v3.0/translate'
    : '/translate';
  const endpoint = `${base}${path}?api-version=3.0&to=${encodeURIComponent(targetLanguage)}${fromParam}&textType=${textType}`;

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

// Splits an array of strings into batches that respect Azure's per-request limits:
// max 100 elements and max 50,000 characters (we stay at 48,000 for headroom).
function chunkTexts(texts, maxElements = 100, maxChars = 48000) {
  const chunks = [];
  let chunk = [], chars = 0;
  for (const text of texts) {
    if (chunk.length >= maxElements || (chunk.length > 0 && chars + text.length > maxChars)) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(text);
    chars += text.length;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

// Thrown after a document's raw translatable text is counted but BEFORE any Azure call,
// so an over-limit document is rejected without spending any translation tokens.
class CharLimitError extends Error {
  constructor(rawChars) {
    super('character-limit-exceeded');
    this.code = 'character-limit-exceeded';
    this.rawChars = rawChars;
  }
}

// budget is the characters remaining on the license (or null for "no limit").
function enforceBudget(rawChars, budget) {
  if (budget != null && rawChars > budget) throw new CharLimitError(rawChars);
}

// OOXML run-property configs. Color/size/weight/font all live inside the run-properties
// element (<w:rPr> / <a:rPr>), so cloning that element preserves basic character formatting.
const DOCX_CFG = { ns: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', prefix: 'w', paraTag: 'p',  runTag: 'r', rPrTag: 'rPr', textTag: 't' };
const PPTX_CFG = { ns: 'http://schemas.openxmlformats.org/drawingml/2006/main',        prefix: 'a', paraTag: 'p',  runTag: 'r', rPrTag: 'rPr', textTag: 't' };
const XLSX_CFG = { ns: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',     prefix: '',  paraTag: 'si', runTag: 'r', rPrTag: 'rPr', textTag: 't' };

// Translates run-formatted OOXML parts while preserving per-run character formatting.
// For each paragraph we wrap every run's text in a <span id="i"> tag and translate it as
// HTML (textType=html), so Azure keeps the tags and moves them to the grammatically correct
// positions in the translated sentence. We then rebuild the runs, cloning each run's <rPr>
// (which carries color, size, weight, and font) onto the matching translated segment.
// Accepts an array of XML strings (e.g. all PPTX slides) so translation batches across them.
// Returns { parts, characters } where characters is the raw visible text count (the words,
// not the run markup) — that is what the customer is charged for.
async function translateOoxmlParts(xmlParts, config, targetLanguage, fromLanguage, budget) {
  const { ns, prefix, paraTag, runTag, rPrTag, textTag } = config;
  // @xmldom/xmldom ≥ 0.9 throws (not just warns) when an XML declaration isn't the
  // very first byte — triggered by a UTF-8 BOM that some OOXML generators prepend.
  // onError: return silently to continue parsing; throw to abort. Suppress the xml
  // declaration position issue but let real fatal errors propagate.
  const parser = new DOMParser({
    onError: (level, msg) => {
      if (String(msg).includes('xml declaration')) return;
      if (level === 'fatalError') throw new Error(String(msg));
    },
  });
  const serializer = new XMLSerializer();
  const qual = (tag) => (prefix ? `${prefix}:${tag}` : tag);
  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stripTags = (s) => String(s).replace(/<[^>]+>/g, '');

  const directChildren = (el, localName) =>
    Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.localName === localName);

  const makeRun = (doc, rPrEl, textVal) => {
    const r = doc.createElementNS(ns, qual(runTag));
    if (rPrEl) r.appendChild(rPrEl.cloneNode(true));
    const t = doc.createElementNS(ns, qual(textTag));
    t.setAttribute('xml:space', 'preserve');
    t.appendChild(doc.createTextNode(textVal));
    r.appendChild(t);
    return r;
  };

  const docs = xmlParts.map((xmlStr) => parser.parseFromString(xmlStr.replace(/^﻿/, ''), 'application/xml'));
  const jobs = [];
  let characters = 0;

  for (const doc of docs) {
    for (const container of Array.from(doc.getElementsByTagNameNS(ns, paraTag))) {
      const runs = directChildren(container, runTag).filter((r) => directChildren(r, textTag).length);

      if (runs.length) {
        // Merge adjacent runs that share identical properties to cut tag overhead.
        const segs = [];
        for (const run of runs) {
          const rPrEl = directChildren(run, rPrTag)[0] || null;
          const text = directChildren(run, textTag).map((t) => t.textContent || '').join('');
          const rPrXml = rPrEl ? serializer.serializeToString(rPrEl) : '';
          const last = segs[segs.length - 1];
          if (last && last.rPrXml === rPrXml) last.text += text;
          else segs.push({ rPrEl, rPrXml, text });
        }
        if (!segs.some((s) => s.text.trim())) continue;

        characters += segs.reduce((sum, s) => sum + s.text.length, 0);
        jobs.push({
          html: segs.map((s, i) => `<span id="${i}">${xmlEscape(s.text)}</span>`).join(''),
          rebuild: (res) => {
            let parsed = null;
            try { parsed = parser.parseFromString(`<_r>${res}</_r>`, 'application/xml').documentElement; } catch {}
            const newRuns = [];
            if (parsed) {
              for (const node of Array.from(parsed.childNodes)) {
                if (node.nodeType === 3 && node.textContent) {
                  newRuns.push(makeRun(doc, null, node.textContent));
                } else if (node.nodeType === 1 && node.localName === 'span') {
                  const seg = segs[Number(node.getAttribute('id'))];
                  newRuns.push(makeRun(doc, seg ? seg.rPrEl : null, node.textContent || ''));
                }
              }
            }
            if (!newRuns.length) newRuns.push(makeRun(doc, segs[0].rPrEl, stripTags(res)));
            const first = runs[0];
            for (const nr of newRuns) container.insertBefore(nr, first);
            for (const old of runs) container.removeChild(old);
          },
        });
      } else {
        // No runs (e.g. a plain XLSX <si> with a single <t>) — nothing to preserve, translate as text.
        const tNodes = directChildren(container, textTag);
        const text = tNodes.map((t) => t.textContent || '').join('');
        if (!tNodes.length || !text.trim()) continue;
        characters += text.length;
        jobs.push({
          html: xmlEscape(text),
          rebuild: (res) => {
            tNodes[0].textContent = stripTags(res);
            for (let j = 1; j < tNodes.length; j++) tNodes[j].textContent = '';
          },
        });
      }
    }
  }

  enforceBudget(characters, budget);

  if (jobs.length) {
    const translated = [];
    for (const chunk of chunkTexts(jobs.map((j) => j.html))) {
      translated.push(...await callAzureTranslate(chunk, targetLanguage, fromLanguage, 'html'));
    }
    jobs.forEach((job, i) => job.rebuild(translated[i] ?? ''));
  }

  return { parts: docs.map((doc) => serializer.serializeToString(doc)), characters };
}

async function translateDocx(inputBuffer, targetLanguage, fromLanguage, budget) {
  const zip = new PizZip(inputBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Invalid DOCX: word/document.xml not found.');

  const { parts: [out], characters } = await translateOoxmlParts([docFile.asText()], DOCX_CFG, targetLanguage, fromLanguage, budget);
  zip.file('word/document.xml', out);
  return { buffer: Buffer.from(zip.generate({ type: 'nodebuffer' })), characters };
}

async function translatePptx(inputBuffer, targetLanguage, fromLanguage, budget) {
  const zip = new PizZip(inputBuffer);

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();

  if (slideFiles.length === 0) return { buffer: inputBuffer, characters: 0 };

  const { parts, characters } = await translateOoxmlParts(
    slideFiles.map((name) => zip.file(name).asText()),
    PPTX_CFG,
    targetLanguage,
    fromLanguage,
    budget,
  );
  slideFiles.forEach((name, i) => zip.file(name, parts[i]));

  return { buffer: Buffer.from(zip.generate({ type: 'nodebuffer' })), characters };
}

async function translateXlsx(inputBuffer, targetLanguage, fromLanguage, budget) {
  const zip = new PizZip(inputBuffer);
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (!ssFile) return { buffer: inputBuffer, characters: 0 };

  const { parts: [out], characters } = await translateOoxmlParts([ssFile.asText()], XLSX_CFG, targetLanguage, fromLanguage, budget);
  zip.file('xl/sharedStrings.xml', out);
  return { buffer: Buffer.from(zip.generate({ type: 'nodebuffer' })), characters };
}

async function translateSubtitleBlocks(text, targetLanguage, fromLanguage, skipBlock, budget) {
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

  if (cueData.length === 0) return { buffer: Buffer.from(text, 'utf8'), characters: 0 };

  const characters = cueData.reduce((sum, c) => sum + c.text.length, 0);
  enforceBudget(characters, budget);

  const translations = [];
  for (const chunk of chunkTexts(cueData.map((c) => c.text))) {
    translations.push(...await callAzureTranslate(chunk, targetLanguage, fromLanguage));
  }

  const output = parsedBlocks.map((pb) => {
    if (pb.type === 'other') return pb.raw;
    const header = pb.lines.slice(0, pb.tsIndex + 1);
    return [...header, translations[pb.cueIdx]].join('\n');
  });

  return { buffer: Buffer.from(output.join('\n\n'), 'utf8'), characters };
}

// RTL script language codes — used to set dir="rtl" on the HTML output so
// Chromium's Bidi algorithm lays out Arabic/Hebrew paragraphs correctly.
const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he', 'yi', 'dv']);

// Accepts structured blocks [{type:'h1'|'h2'|'h3'|'p'|'li', translated:string}].
// Consecutive 'li' blocks are wrapped in <ul>. CSS sizes each element type relative
// to a 12pt body so headings appear proportional regardless of source font scale.
function buildPdfHtml(blocks, targetLanguage) {
  const isRtl = RTL_LANGS.has(targetLanguage.split('-')[0]);
  const dir = isRtl ? 'rtl' : 'ltr';
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; font-size: 12pt; line-height: 1.6; color: #000;
           padding: 72px; direction: ${dir}; unicode-bidi: plaintext; }
    h1 { font-size: 20pt; font-weight: bold; margin-bottom: 6pt; }
    h2 { font-size: 15pt; font-weight: bold; margin-top: 14pt; margin-bottom: 4pt; }
    h3 { font-size: 13pt; font-weight: bold; margin-top: 10pt; margin-bottom: 3pt; }
    p  { margin-bottom: 8pt; word-break: break-word; }
    ul { margin: 0 0 8pt 20pt; }
    li { margin-bottom: 3pt; }
  `;

  let body = '';
  let inList = false;
  for (const block of blocks) {
    if (block.type === 'li') {
      if (!inList) { body += '<ul>\n'; inList = true; }
      body += `<li>${esc(block.translated)}</li>\n`;
    } else {
      if (inList) { body += '</ul>\n'; inList = false; }
      body += `<${block.type}>${esc(block.translated)}</${block.type}>\n`;
    }
  }
  if (inList) body += '</ul>\n';

  return `<!DOCTYPE html>\n<html lang="${esc(targetLanguage)}" dir="${dir}">\n<head><meta charset="utf-8"><style>${css}</style></head>\n<body>\n${body}</body>\n</html>`;
}

async function translatePdf(inputBuffer, targetLanguage, fromLanguage, budget) {
  // Use pdfjs-dist directly (transitive dep of pdf-parse) to access per-item font
  // size (transform[3]) and y-position — data that pdf-parse's getText() discards.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const pdfDoc = await pdfjs.getDocument({
    data: new Uint8Array(inputBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const allLines = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();

    // Flip PDF y (bottom-up) to screen y (top-down) for reading-order sorting.
    const items = tc.items
      .filter((item) => 'str' in item && item.str.trim())
      .map((item) => ({
        str: item.str,
        x: item.transform[4],
        y: viewport.height - item.transform[5],
        h: Math.abs(item.transform[3]) || Math.abs(item.height) || 0,
      }))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    // Group items within ±3 units vertically into the same line.
    for (const item of items) {
      const last = allLines[allLines.length - 1];
      if (last && last.page === pageNum && Math.abs(item.y - last.y) < 3) {
        last.items.push(item);
        last.h = Math.max(last.h, item.h);
      } else {
        allLines.push({ y: item.y, h: item.h, page: pageNum, items: [item] });
      }
    }

    page.cleanup();
  }

  await pdfDoc.destroy();
  if (allLines.length === 0) return { pdfHtml: null, characters: 0 };

  // Sort items within each line left-to-right and join into a single string.
  for (const line of allLines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.map((i) => i.str).join('').trim();
  }

  // Body font size = modal rounded height across all lines.
  const counts = {};
  for (const l of allLines) {
    if (l.h > 0) { const k = Math.round(l.h); counts[k] = (counts[k] || 0) + 1; }
  }
  const bodyH = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 12);

  const BULLET = /^[•·∙●○▪▸►→\-\*]\s/;

  const blocks = [];
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line.text) continue;

    const prev = allLines[i - 1];
    const diffPage = prev && line.page !== prev.page;
    const gap = (!diffPage && prev) ? (line.y - prev.y) : Infinity;
    const isParaBreak = diffPage || gap > bodyH * 1.5;

    const ratio = bodyH > 0 ? line.h / bodyH : 1;
    const type = BULLET.test(line.text) ? 'li'
      : ratio > 1.5  ? 'h1'
      : ratio > 1.25 ? 'h2'
      : ratio > 1.1  ? 'h3'
      : 'p';

    // Merge consecutive body-text lines into one paragraph unless there's a gap.
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'p' && type === 'p' && !isParaBreak) {
      last.text += ' ' + line.text;
    } else {
      blocks.push({ type, text: line.text });
    }
  }

  const valid = blocks.filter((b) => b.text.length > 1);
  if (valid.length === 0) return { pdfHtml: null, characters: 0 };

  const characters = valid.reduce((sum, b) => sum + b.text.length, 0);
  enforceBudget(characters, budget);

  const translations = [];
  for (const chunk of chunkTexts(valid.map((b) => b.text))) {
    translations.push(...await callAzureTranslate(chunk, targetLanguage, fromLanguage));
  }
  for (let i = 0; i < valid.length; i++) {
    valid[i].translated = translations[i] ?? valid[i].text;
  }

  return { pdfHtml: buildPdfHtml(valid, targetLanguage), characters };
}

async function translateSrt(inputBuffer, targetLanguage, fromLanguage, budget) {
  return translateSubtitleBlocks(inputBuffer.toString('utf8'), targetLanguage, fromLanguage, null, budget);
}

async function translateVtt(inputBuffer, targetLanguage, fromLanguage, budget) {
  return translateSubtitleBlocks(inputBuffer.toString('utf8'), targetLanguage, fromLanguage, (block) => {
    const t = block.trim();
    return t === 'WEBVTT' || t.startsWith('WEBVTT ') || t.startsWith('NOTE') || t.startsWith('STYLE') || t.startsWith('REGION');
  }, budget);
}

async function translateEpub(inputBuffer, targetLanguage, fromLanguage, budget) {
  const zip = new PizZip(inputBuffer);
  const parser = new DOMParser();
  const serializer = new XMLSerializer();

  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('Invalid EPUB: META-INF/container.xml not found.');

  const containerDoc = parser.parseFromString(containerFile.asText(), 'application/xml');
  const rootfileEl = containerDoc.getElementsByTagName('rootfile')[0];
  if (!rootfileEl) throw new Error('Invalid EPUB: no rootfile element found.');
  const opfPath = rootfileEl.getAttribute('full-path');
  if (!opfPath) throw new Error('Invalid EPUB: rootfile missing full-path attribute.');

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error(`Invalid EPUB: OPF file not found at ${opfPath}.`);

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfDoc = parser.parseFromString(opfFile.asText(), 'application/xml');

  // Build id → resolved path map from manifest (HTML/XHTML content only)
  const idToPath = {};
  const manifestItems = opfDoc.getElementsByTagName('item');
  for (let i = 0; i < manifestItems.length; i++) {
    const id   = manifestItems[i].getAttribute('id');
    const href = manifestItems[i].getAttribute('href');
    const mt   = manifestItems[i].getAttribute('media-type') || '';
    if (id && href && (mt.includes('html') || mt.includes('xhtml'))) {
      idToPath[id] = opfDir + decodeURIComponent(href.split('#')[0]);
    }
  }

  // Walk spine in reading order
  const contentPaths = [];
  const itemrefs = opfDoc.getElementsByTagName('itemref');
  for (let i = 0; i < itemrefs.length; i++) {
    const idref = itemrefs[i].getAttribute('idref');
    if (idref && idToPath[idref]) contentPaths.push(idToPath[idref]);
  }

  if (contentPaths.length === 0) throw new Error('EPUB contains no readable content documents.');

  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  function getByTag(doc, tag) {
    const byNS = Array.from(doc.getElementsByTagNameNS(XHTML_NS, tag));
    return byNS.length ? byNS : Array.from(doc.getElementsByTagName(tag));
  }

  // Serialize only the children of an element (inner XML), stripping the outer tag.
  function innerXML(el) {
    return Array.from(el.childNodes).map((child) => {
      if (child.nodeType === 3) return child.textContent;
      return serializer.serializeToString(child);
    }).join('');
  }

  // Replace an element's children with parsed HTML from a translated string.
  // Falls back to a plain text node if the translated string can't be parsed.
  function setInnerXML(el, doc, html) {
    while (el.firstChild) el.removeChild(el.firstChild);
    try {
      const wrapped = parser.parseFromString(
        `<_r xmlns="${XHTML_NS}">${html}</_r>`,
        'application/xml',
      );
      const root = wrapped.documentElement;
      while (root.firstChild) el.appendChild(doc.importNode(root.firstChild, true));
    } catch {
      el.appendChild(doc.createTextNode(html));
    }
  }

  const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'caption', 'blockquote', 'dt', 'dd'];

  // First pass: parse every content document and collect all translatable blocks, counting
  // the raw visible text (textContent, not the inline markup) so we can enforce the license
  // budget before spending any translation tokens.
  const openDocs = [];   // { path, doc }
  const blockData = [];  // { el, doc, html }
  let characters = 0;

  for (const contentPath of contentPaths) {
    const file = zip.file(contentPath);
    if (!file) continue;

    const doc = parser.parseFromString(file.asText(), 'application/xml');
    let touched = false;

    for (const tag of BLOCK_TAGS) {
      for (const el of getByTag(doc, tag)) {
        const text = (el.textContent || '').trim();
        if (text) {
          characters += text.length;
          blockData.push({ el, doc, html: innerXML(el) });
          touched = true;
        }
      }
    }

    if (touched) openDocs.push({ path: contentPath, doc });
  }

  enforceBudget(characters, budget);

  // Send inner HTML to Azure with textType=html (batched across all chapters) so inline tags
  // like <em>/<strong>/<a> are preserved and repositioned in the translated text.
  if (blockData.length) {
    const translations = [];
    for (const chunk of chunkTexts(blockData.map((d) => d.html))) {
      translations.push(...await callAzureTranslate(chunk, targetLanguage, fromLanguage, 'html'));
    }
    blockData.forEach(({ el, doc }, idx) => setInnerXML(el, doc, translations[idx] ?? ''));
  }

  for (const { path: contentPath, doc } of openDocs) {
    zip.file(contentPath, serializer.serializeToString(doc));
  }

  return { buffer: Buffer.from(zip.generate({ type: 'nodebuffer' })), characters };
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
    const isPdf  = nameLower.endsWith('.pdf')  || mimeType === 'application/pdf';
    const isSrt  = nameLower.endsWith('.srt');
    const isVtt  = nameLower.endsWith('.vtt');
    const isEpub = nameLower.endsWith('.epub') || mimeType === 'application/epub+zip';
    const isTextFile = isLikelyText(mimeType, fileName);

    // Customers are charged only for the raw translatable text (the visible words), not the
    // file's byte size. Each translator counts that text during extraction and throws a
    // CharLimitError BEFORE any Azure call if it exceeds the remaining budget, so an
    // over-limit document is rejected without wasting any translation tokens.
    const willTranslate = AZURE_TRANSLATOR_KEY &&
      (isDocx || isPptx || isXlsx || isPdf || isSrt || isVtt || isEpub || isTextFile);

    const rec = resolved.record;
    const reqLimit  = Number(rec.limit || 0);
    const reqUsed   = Number(rec.requests || 0);
    const charLimit = Number(rec.charLimit || 0);
    const charUsed  = Number(rec.characters || 0);
    const budget = charLimit > 0 ? Math.max(0, charLimit - charUsed) : null;

    if (willTranslate && reqLimit > 0 && reqUsed >= reqLimit) {
      return res.status(402).json({
        ok: false,
        error: 'request-limit-exceeded',
        message: 'Your license has reached its request limit.',
      });
    }

    let outputBuffer = inputBuffer;
    let outputFileName = fileName;
    let mode = 'binary-pass-through';
    let charactersCharged = 0;
    let pdfHtml = null;

    try {
      if (AZURE_TRANSLATOR_KEY) {
        if (isDocx) {
          ({ buffer: outputBuffer, characters: charactersCharged } = await translateDocx(inputBuffer, targetLanguage, fromLanguage, budget));
          mode = 'docx-translation';
        } else if (isPptx) {
          ({ buffer: outputBuffer, characters: charactersCharged } = await translatePptx(inputBuffer, targetLanguage, fromLanguage, budget));
          mode = 'pptx-translation';
        } else if (isXlsx) {
          ({ buffer: outputBuffer, characters: charactersCharged } = await translateXlsx(inputBuffer, targetLanguage, fromLanguage, budget));
          mode = 'xlsx-translation';
        } else if (isPdf) {
          const pdfResult = await translatePdf(inputBuffer, targetLanguage, fromLanguage, budget);
          charactersCharged = pdfResult.characters;
          if (pdfResult.pdfHtml) {
            pdfHtml = pdfResult.pdfHtml;
            // Placeholder so storeTranslationAssets creates the directory and metadata.
            // The Electron main process overwrites this with the real PDF via printToPDF().
            outputBuffer = Buffer.from('%PDF-PLACEHOLDER');
          }
          mode = 'pdf-translation';
        } else if (isSrt) {
          ({ buffer: outputBuffer, characters: charactersCharged } = await translateSrt(inputBuffer, targetLanguage, fromLanguage, budget));
          mode = 'srt-translation';
        } else if (isVtt) {
          ({ buffer: outputBuffer, characters: charactersCharged } = await translateVtt(inputBuffer, targetLanguage, fromLanguage, budget));
          mode = 'vtt-translation';
        } else if (isEpub) {
          ({ buffer: outputBuffer, characters: charactersCharged } = await translateEpub(inputBuffer, targetLanguage, fromLanguage, budget));
          mode = 'epub-translation';
        } else if (isTextFile) {
          const inputText = inputBuffer.toString('utf8');
          charactersCharged = inputText.length;
          enforceBudget(charactersCharged, budget);
          const translatedText = await translateText(inputText, targetLanguage, fromLanguage);
          outputBuffer = Buffer.from(translatedText, 'utf8');
          mode = 'azure-text-translation';
        }
      }
    } catch (err) {
      if (err instanceof CharLimitError) {
        return res.status(402).json({
          ok: false,
          error: 'character-limit-exceeded',
          message: `This document contains ${err.rawChars.toLocaleString()} characters of text but your license only has ${(budget ?? 0).toLocaleString()} characters remaining.`,
        });
      }
      throw err;
    }

    const translationId = randomUUID();
    const usageRecord = await incrementLicenseUsage(resolved.licenseKey, 1, charactersCharged);

    const stored = await storeTranslationAssets({
      org: usageRecord.org,
      translationId,
      targetLanguage,
      fileName: outputFileName,
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
      fileName: outputFileName,
      targetLanguage,
      usage: {
        requests: Number(usageRecord.requests || 0),
        limit: Number(usageRecord.limit || 0),
        characters: Number(usageRecord.characters || 0),
        charLimit: Number(usageRecord.charLimit || 0),
      },
      // pdfHtml is base64-encoded HTML returned only for PDF translations.
      // The Electron main process renders it to a real PDF via printToPDF().
      ...(pdfHtml !== null && {
        pdfHtml: Buffer.from(pdfHtml, 'utf8').toString('base64'),
      }),
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

export async function clearTranslationsHandler(req, res) {
  try {
    const resolved = await resolveLicenseFromBearer(req);
    if (!resolved.valid || !resolved.record) {
      return res.status(401).json({ ok: false, error: resolved.reason || 'invalid-license' });
    }

    const lang = String(req.query.lang || '').trim();
    if (!lang) {
      return res.status(400).json({ ok: false, error: 'lang query param is required.' });
    }

    await clearTranslationsForLanguage(resolved.record.org, lang);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to clear translations.' });
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
