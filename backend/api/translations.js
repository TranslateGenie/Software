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
  updateTranslationMetadata,
  writeTranslationFile,
} from '../lib/user-storage.js';
import { resolveLicenseFromBearer } from './validate-license.js';

const AZURE_TRANSLATOR_KEY = process.env.AZURE_TRANSLATOR_KEY || '';
const AZURE_TRANSLATOR_REGION = process.env.AZURE_TRANSLATOR_REGION || '';
const AZURE_TRANSLATOR_ENDPOINT = process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';

// Azure Document Intelligence (Layout model) powers the premium "AI Format Polish" reformat.
const DOCUMENT_INTELLIGENCE_ENDPOINT = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT || '';
const DOCUMENT_INTELLIGENCE_KEY = process.env.DOCUMENT_INTELLIGENCE_KEY || '';
const REFORMAT_CHARS_PER_PAGE = 2000;

// Azure OpenAI (gpt-5-mini) powers the premium "AI Language Polish" — rewrites the already-
// translated text to read natively, without re-translating. Uses the v1 chat-completions surface
// (deployment passed as `model`), which the gpt-5 family requires; gpt-5 models also reject
// custom `temperature`, so none is sent.
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || '';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5-mini';
const POLISH_CHARS_PER_PAGE = 1000;
// Non-PDF docs have no page count, so a "page" is estimated as this many translated characters.
const POLISH_PAGE_ESTIMATE_CHARS = 3000;

const POLISH_SYSTEM_PROMPT =
  'You are a professional copy editor. Improve the fluency and naturalness of the user\'s text so ' +
  'it reads as if originally written by a native speaker of whatever language it is in. Preserve ' +
  'the meaning exactly. Do not translate into another language. Do not add, remove, or reorder ' +
  'information. If the text contains markup tags (such as <span id="0">), timestamps, code, ' +
  'numbers, or placeholders, keep them exactly where they are and only improve the natural-language ' +
  'text around them. Reply with ONLY the improved text — no commentary, no quotes.';

// Polishes each text through Azure OpenAI chat completions with bounded concurrency.
// Per-item transient failures fall back to the original text (a partially polished document is
// better than a failed one); config/auth failures (401/403/404) abort the whole run.
async function callAzureOpenAIPolish(texts) {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_KEY) {
    throw new Error('Azure OpenAI is not configured. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY.');
  }
  // Normalize whatever endpoint shape the Azure/Foundry portal was copied from — a bare resource
  // endpoint, a full target URI with an /openai/... path + api-version, or the /models inference
  // endpoint — down to the resource base before appending the v1 chat-completions path.
  const base = AZURE_OPENAI_ENDPOINT
    .replace(/[?#].*$/, '')
    .replace(/\/(openai|models)(\/.*)?$/, '')
    .replace(/\/+$/, '');
  const url = `${base}/openai/v1/chat/completions`;
  // 'minimal' reasoning keeps gpt-5-family latency/cost right for a copy-edit task; omitted for
  // non-gpt-5 deployment names, where the parameter would be rejected.
  const isGpt5 = /^gpt-5/i.test(AZURE_OPENAI_DEPLOYMENT);

  const polishOne = async (text) => {
    if (!text || !String(text).trim()) return text;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': AZURE_OPENAI_KEY },
      body: JSON.stringify({
        model: AZURE_OPENAI_DEPLOYMENT,
        messages: [
          { role: 'system', content: POLISH_SYSTEM_PROMPT },
          { role: 'user', content: String(text) },
        ],
        ...(isGpt5 ? { reasoning_effort: 'minimal' } : {}),
      }),
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      const detail = await response.text();
      const err = new Error(detail || `Azure OpenAI request failed (${response.status}).`);
      err.fatal = true;
      throw err;
    }
    if (!response.ok) throw new Error(`Azure OpenAI transient error (${response.status}).`);
    const data = await response.json();
    const choice = data?.choices?.[0];
    const out = choice?.message?.content;
    // Content-filtered or empty responses keep the original text untouched.
    if (!out || choice?.finish_reason === 'content_filter') return text;
    return out;
  };

  const results = new Array(texts.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(5, texts.length) }, async () => {
    while (next < texts.length) {
      const i = next++;
      try {
        results[i] = await polishOne(texts[i]);
      } catch (err) {
        if (err.fatal) throw err;
        try {
          results[i] = await polishOne(texts[i]); // one retry, then keep the original
        } catch (err2) {
          if (err2.fatal) throw err2;
          results[i] = texts[i];
        }
      }
    }
  });
  await Promise.all(workers);
  return results;
}

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
// Inline strings in worksheets (cells with t="inlineStr") use the same run structure as
// sharedStrings but wrap it in an <is> container instead of <si>.
const XLSX_INLINE_CFG = { ...XLSX_CFG, paraTag: 'is' };

// Translates run-formatted OOXML parts while preserving per-run character formatting.
// For each paragraph we wrap every run's text in a <span id="i"> tag and translate it as
// HTML (textType=html), so Azure keeps the tags and moves them to the grammatically correct
// positions in the translated sentence. We then rebuild the runs, cloning each run's <rPr>
// (which carries color, size, weight, and font) onto the matching translated segment.
// Accepts an array of XML strings (e.g. all PPTX slides) so translation batches across them.
// Returns { parts, characters } where characters is the raw visible text count (the words,
// not the run markup) — that is what the customer is charged for.
// `transform` (optional) replaces the Azure-translate step with any texts→texts function (e.g.
// the GPT language polish); it receives the span-tagged HTML segments and must return them in
// order with the <span id> markup preserved where possible (the rebuild falls back gracefully).
async function translateOoxmlParts(xmlParts, config, targetLanguage, fromLanguage, budget, transform = null) {
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
    const htmls = jobs.map((j) => j.html);
    let translated;
    if (transform) {
      translated = await transform(htmls);
    } else {
      translated = [];
      for (const chunk of chunkTexts(htmls)) {
        translated.push(...await callAzureTranslate(chunk, targetLanguage, fromLanguage, 'html'));
      }
    }
    jobs.forEach((job, i) => job.rebuild(translated[i] ?? ''));
  }

  return { parts: docs.map((doc) => serializer.serializeToString(doc)), characters };
}

// Translates a set of OOXML parts (matched by regex against the zip's file names) in a single
// batched pass and writes each result back to the same part. Returns the summed visible-text
// `characters`. Parts that don't exist are silently skipped, so callers can list optional parts
// (headers, footnotes, speaker notes, …) without first checking for them.
async function translateZipParts(zip, namePattern, config, targetLanguage, fromLanguage, budget, transform = null) {
  const names = Object.keys(zip.files).filter((name) => namePattern.test(name)).sort();
  if (names.length === 0) return 0;

  const { parts, characters } = await translateOoxmlParts(
    names.map((name) => zip.file(name).asText()),
    config,
    targetLanguage,
    fromLanguage,
    budget,
    transform,
  );
  names.forEach((name, i) => zip.file(name, parts[i]));
  return characters;
}

async function translateDocx(inputBuffer, targetLanguage, fromLanguage, budget) {
  const zip = new PizZip(inputBuffer);
  if (!zip.file('word/document.xml')) throw new Error('Invalid DOCX: word/document.xml not found.');

  // Translate the main body plus every part that carries visible text: headers, footers,
  // foot/endnotes, and comments. Text boxes live inside document.xml as w:p, so they are
  // already covered. All parts use the same wordprocessingml namespace (DOCX_CFG).
  const characters = await translateZipParts(
    zip,
    /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/,
    DOCX_CFG,
    targetLanguage,
    fromLanguage,
    budget,
  );
  return { buffer: Buffer.from(zip.generate({ type: 'nodebuffer' })), characters };
}

async function translatePptx(inputBuffer, targetLanguage, fromLanguage, budget) {
  const zip = new PizZip(inputBuffer);

  // Slides, speaker notes, and SmartArt diagram data all use the drawingml (a:) namespace, so
  // they batch through one PPTX_CFG pass. Embedded chart text uses the c: namespace and is
  // deferred to a later pass.
  const characters = await translateZipParts(
    zip,
    /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+|diagrams\/data\d+)\.xml$/,
    PPTX_CFG,
    targetLanguage,
    fromLanguage,
    budget,
  );
  if (characters === 0) return { buffer: inputBuffer, characters: 0 };

  return { buffer: Buffer.from(zip.generate({ type: 'nodebuffer' })), characters };
}

async function translateXlsx(inputBuffer, targetLanguage, fromLanguage, budget) {
  const zip = new PizZip(inputBuffer);

  // Most cell text lives in the shared-string table (<si> containers). Pass 1 handles it.
  const ssChars = await translateZipParts(
    zip, /^xl\/sharedStrings\.xml$/, XLSX_CFG, targetLanguage, fromLanguage, budget,
  );

  // Pass 2: inline strings written directly into worksheets (<is> containers). Decrement the
  // remaining budget by what pass 1 already counted so enforcement is on the combined total.
  // Chart/drawing text uses other namespaces and is deferred to a later pass.
  const inlineBudget = budget == null ? null : budget - ssChars;
  const inlineChars = await translateZipParts(
    zip, /^xl\/worksheets\/sheet\d+\.xml$/, XLSX_INLINE_CFG, targetLanguage, fromLanguage, inlineBudget,
  );

  const characters = ssChars + inlineChars;
  if (characters === 0) return { buffer: inputBuffer, characters: 0 };
  return { buffer: Buffer.from(zip.generate({ type: 'nodebuffer' })), characters };
}

async function translateSubtitleBlocks(text, targetLanguage, fromLanguage, skipBlock, budget, transform = null) {
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

  const cueTexts = cueData.map((c) => c.text);
  let translations;
  if (transform) {
    translations = await transform(cueTexts);
  } else {
    translations = [];
    for (const chunk of chunkTexts(cueTexts)) {
      translations.push(...await callAzureTranslate(chunk, targetLanguage, fromLanguage));
    }
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

// Target languages whose script pdf-lib cannot draw correctly without a shaping engine, so the
// whole document routes to the Chromium reflow path (which shapes text and supplies fonts):
//   - RTL scripts need contextual joining + bidi reordering
//   - Indic/Brahmic + SE-Asian scripts need glyph reordering and ligatures
// Overlay-safe scripts draw glyph-by-glyph LTR and only need a bundled font: Latin/Cyrillic/Greek
// (Noto Sans) and Simplified Chinese (Noto Sans SC — CJK is shaping-free). Traditional Chinese,
// Japanese, and Korean stay deferred until their fonts are bundled too (same mechanism, more
// font files). The Electron renderer must have a font for every language marked overlay-safe here.
const OVERLAY_UNSAFE_LANGS = new Set([
  'ar', 'fa', 'ur', 'he', 'yi', 'dv', 'ps', 'sd', 'ckb', 'ug',          // RTL
  'zh-hant', 'zh-tw', 'zh-hk', 'zh-mo', 'ja', 'ko', 'yue',             // CJK not yet bundled (Traditional/JP/KR)
  'hi', 'bn', 'pa', 'gu', 'or', 'ta', 'te', 'kn', 'ml', 'si', 'ne',    // Indic
  'mr', 'as', 'sa', 'th', 'lo', 'km', 'my', 'bo', 'dz', 'am', 'ti',    // Indic / SE-Asian
]);

function isOverlaySafeLang(targetLanguage) {
  const base = String(targetLanguage).toLowerCase();
  return !OVERLAY_UNSAFE_LANGS.has(base) && !OVERLAY_UNSAFE_LANGS.has(base.split('-')[0]);
}

// Multi-column detection. Multi-column pages reconstruct poorly in place, so they route to
// reflow. Two signals, because columns surface differently depending on how lines were grouped:
//   A) Left-edge clustering — columns whose lines stayed separate produce 2+ separated clusters
//      of line start-x.
//   B) Vertical gutter — side-by-side column lines that share a baseline merge into one line; we
//      catch those by a wide internal horizontal gap straddling the page midline on many lines.
// pageWidth is the page width in PDF units.
function detectMultiColumn(lines, pageWidth) {
  if (lines.length < 6) return false;

  const lefts = lines.map((l) => l.left).sort((a, b) => a - b);
  const gutter = pageWidth * 0.12;
  const clusters = [[lefts[0]]];
  for (let i = 1; i < lefts.length; i++) {
    if (lefts[i] - lefts[i - 1] > gutter) clusters.push([]);
    clusters[clusters.length - 1].push(lefts[i]);
  }
  if (clusters.filter((c) => c.length >= lines.length * 0.2).length >= 2) return true;

  const mid = pageWidth * 0.5;
  let gutterLines = 0;
  for (const line of lines) {
    const items = line.items || [];
    for (let i = 1; i < items.length; i++) {
      const prevRight = items[i - 1].x + items[i - 1].w;
      if (items[i].x - prevRight > pageWidth * 0.1 && prevRight < mid && items[i].x > mid) {
        gutterLines++;
        break;
      }
    }
  }
  return gutterLines >= lines.length * 0.3;
}

// Table detection: a tabular line has multiple wide internal horizontal gaps between its runs.
// If a large share of lines look tabular, in-place overlay would misalign columns, so reflow.
function detectTableLike(lines) {
  if (lines.length < 4) return false;
  let tabular = 0;
  for (const line of lines) {
    const items = line.items;
    if (items.length < 3) continue;
    const charW = line.h * 0.5 || 6;
    let gaps = 0;
    for (let i = 1; i < items.length; i++) {
      const prevRight = items[i - 1].x + items[i - 1].w;
      if (items[i].x - prevRight > charW * 3) gaps++;
    }
    if (gaps >= 2) tabular++;
  }
  return tabular >= lines.length * 0.3;
}

async function translatePdf(inputBuffer, targetLanguage, fromLanguage, budget) {
  // Use pdfjs-dist directly (transitive dep of pdf-parse) to access per-item font size
  // (transform[3]), position (transform[4]/[5]), and advance width (item.width) — data that
  // pdf-parse's getText() discards but the layout-faithful overlay needs.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const pdfDoc = await pdfjs.getDocument({
    data: new Uint8Array(inputBuffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pageCount = pdfDoc.numPages;
  const overlaySafe = isOverlaySafeLang(targetLanguage);
  const BULLET = /^[•·∙●○▪▸►→\-\*]\s/;

  // Per-page line extraction. Coordinates are kept in NATIVE PDF user space (origin bottom-left,
  // y up) — the same space pdf-lib uses — so overlay coordinates line up with the original page
  // directly. A flipped `yTop` (top-down) is computed only for reading-order sorting/grouping.
  const pageData = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    const tc = await page.getTextContent();

    const items = tc.items
      .filter((item) => 'str' in item && item.str.trim())
      .map((item) => {
        const h = Math.abs(item.transform[3]) || Math.abs(item.height) || 0;
        const x = item.transform[4];
        const baseY = item.transform[5];          // native baseline (bottom-up)
        return { str: item.str, x, baseY, w: item.width || 0, h, yTop: pageHeight - baseY };
      })
      .sort((a, b) => a.yTop - b.yTop || a.x - b.x);

    // Group items within ±3 units vertically into one line.
    const lines = [];
    for (const item of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(item.yTop - last.yTop) < 3) {
        last.items.push(item);
        last.h = Math.max(last.h, item.h);
      } else {
        lines.push({ yTop: item.yTop, h: item.h, items: [item] });
      }
    }

    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      line.text = line.items.map((i) => i.str).join('').trim();
      // Native (bottom-up) bounding box of the line.
      line.left = Math.min(...line.items.map((i) => i.x));
      line.right = Math.max(...line.items.map((i) => i.x + i.w));
      line.top = Math.max(...line.items.map((i) => i.baseY + i.h));        // highest point
      line.bottom = Math.min(...line.items.map((i) => i.baseY - i.h * 0.25)); // lowest point
    }

    pageData.push({ pageNum, width: viewport.width, height: pageHeight, lines: lines.filter((l) => l.text) });
    page.cleanup();
  }
  await pdfDoc.destroy();

  const allLines = pageData.flatMap((p) => p.lines);
  if (allLines.length === 0) return { pdf: null, characters: 0 };

  // Body font size = modal rounded line height across the whole document.
  const counts = {};
  for (const l of allLines) {
    if (l.h > 0) { const k = Math.round(l.h); counts[k] = (counts[k] || 0) + 1; }
  }
  const bodyH = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 12);

  // Classify each page's lines into blocks, carrying geometry so the overlay can place each
  // translated block back into its source region. Headings/bullets are one line per block; body
  // lines merge into paragraphs (better translation quality) and their boxes union together.
  for (const page of pageData) {
    const blocks = [];
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i];
      const prev = page.lines[i - 1];
      const gap = prev ? (line.yTop - prev.yTop) : Infinity;
      const isParaBreak = gap > bodyH * 1.5;

      const ratio = bodyH > 0 ? line.h / bodyH : 1;
      const type = BULLET.test(line.text) ? 'li'
        : ratio > 1.5  ? 'h1'
        : ratio > 1.25 ? 'h2'
        : ratio > 1.1  ? 'h3'
        : 'p';

      const last = blocks[blocks.length - 1];
      if (last && last.type === 'p' && type === 'p' && !isParaBreak) {
        last.text += ' ' + line.text;
        last.left = Math.min(last.left, line.left);
        last.right = Math.max(last.right, line.right);
        last.top = Math.max(last.top, line.top);
        last.bottom = Math.min(last.bottom, line.bottom);
      } else {
        blocks.push({ type, text: line.text, fontSize: line.h || bodyH,
          left: line.left, right: line.right, top: line.top, bottom: line.bottom });
      }
    }
    page.blocks = blocks.filter((b) => b.text.length > 1);
  }

  // Per-page routing. A page reflows if the target script isn't overlay-safe, or the page is
  // multi-column / table-like (in-place text would misalign). Otherwise it gets a vector overlay.
  for (const page of pageData) {
    page.mode = (!overlaySafe
      || detectMultiColumn(page.lines, page.width)
      || detectTableLike(page.lines))
      ? 'reflow' : 'overlay';
  }

  // Charge for all visible block text, enforced once before any Azure call.
  const allBlocks = pageData.flatMap((p) => p.blocks);
  if (allBlocks.length === 0) return { pdf: null, characters: 0 };
  const characters = allBlocks.reduce((sum, b) => sum + b.text.length, 0);
  enforceBudget(characters, budget);

  // Translate every block in batches across the whole document.
  const translations = [];
  for (const chunk of chunkTexts(allBlocks.map((b) => b.text))) {
    translations.push(...await callAzureTranslate(chunk, targetLanguage, fromLanguage));
  }
  allBlocks.forEach((b, i) => { b.translated = translations[i] ?? b.text; });

  // Sidecar = the per-document translation memory + geometry + page routing, persisted on-device
  // so the paid AI Polish actions can rebuild output WITHOUT re-running translation:
  //  - Format polish (Azure DI) uses blocks as a source→translated TM.
  //  - Language polish rewrites blocks[].translated and re-renders using pages[].mode routing.
  // Block coords are native PDF space (bottom-left origin), matching pdf-lib.
  const sidecar = {
    pageCount: pageData.length,
    pages: pageData.map((p) => ({ page: p.pageNum, mode: p.mode })),
    blocks: pageData.flatMap((page) =>
      page.blocks.map((b) => ({
        source: b.text,
        translated: b.translated,
        page: page.pageNum,
        x: b.left,
        y: b.bottom,
        w: Math.max(0, b.right - b.left),
        h: Math.max(0, b.top - b.bottom),
        fontSize: b.fontSize,
        type: b.type,
      })),
    ),
  };

  // Fast path: when every page reflows (e.g. a complex-script target), return one combined HTML
  // document and let Electron render it in a single Chromium pass — no pdf-lib, no original-PDF
  // round-trip. This is the same cheap path the pipeline used before overlay support.
  if (pageData.every((p) => p.mode === 'reflow')) {
    return { pdf: { allReflowHtml: buildPdfHtml(allBlocks, targetLanguage) }, sidecar, pageCount, characters };
  }

  // Mixed/overlay document: structured per-page payload. Overlay pages carry cover boxes +
  // positioned translated runs (native PDF coords); reflow pages carry their own HTML. Electron
  // copies overlay pages from the original (keeping vector graphics) and merges the rest.
  const pages = pageData.map((page) => {
    if (page.mode === 'overlay') {
      return {
        mode: 'overlay',
        runs: page.blocks.map((b) => ({
          x: b.left, y: b.bottom, w: Math.max(0, b.right - b.left), h: Math.max(0, b.top - b.bottom),
          fontSize: b.fontSize, translated: b.translated,
        })),
      };
    }
    return { mode: 'reflow', html: buildPdfHtml(page.blocks, targetLanguage) };
  });

  return {
    // targetLanguage lets the Electron overlay renderer pick the right embedded font
    // (e.g. Noto Sans SC for Simplified Chinese vs Noto Sans for Latin/Cyrillic/Greek).
    pdf: { originalPdfBase64: inputBuffer.toString('base64'), pages, targetLanguage },
    sidecar,
    pageCount,
    characters,
  };
}

async function translateSrt(inputBuffer, targetLanguage, fromLanguage, budget, transform = null) {
  return translateSubtitleBlocks(inputBuffer.toString('utf8'), targetLanguage, fromLanguage, null, budget, transform);
}

async function translateVtt(inputBuffer, targetLanguage, fromLanguage, budget, transform = null) {
  return translateSubtitleBlocks(inputBuffer.toString('utf8'), targetLanguage, fromLanguage, (block) => {
    const t = block.trim();
    return t === 'WEBVTT' || t.startsWith('WEBVTT ') || t.startsWith('NOTE') || t.startsWith('STYLE') || t.startsWith('REGION');
  }, budget, transform);
}

async function translateEpub(inputBuffer, targetLanguage, fromLanguage, budget, transform = null) {
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
    const blockHtmls = blockData.map((d) => d.html);
    let translations;
    if (transform) {
      translations = await transform(blockHtmls);
    } else {
      translations = [];
      for (const chunk of chunkTexts(blockHtmls)) {
        translations.push(...await callAzureTranslate(chunk, targetLanguage, fromLanguage, 'html'));
      }
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
    mode: String(meta?.mode || ''),
    pageCount: Number(meta?.pageCount || 0),
    // The UI uses these to drive the "AI Polish" dropdown (Format is PDF-only) and badges.
    reformatEligible: Boolean(meta?.sidecarKey && meta?.inputKey && meta?.mode === 'pdf-translation'),
    polishEligible: Boolean(
      meta?.mode && meta.mode !== 'binary-pass-through' &&
      (meta.mode !== 'pdf-translation' || meta?.sidecarKey),
    ),
    aiFormatted: Boolean(meta?.formattedOutputKey),
    aiPolished: Boolean(meta?.languagePolishedOutputKey),
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
    const charLimit = Number(rec.charLimit || 0);
    const charUsed  = Number(rec.characters || 0);
    const budget = charLimit > 0 ? Math.max(0, charLimit - charUsed) : null;

    // Documents are unlimited — licenses are metered by characters only. The per-request/document
    // limit is no longer enforced (the `requests` counter is still incremented below for tracking).

    let outputBuffer = inputBuffer;
    let outputFileName = fileName;
    let mode = 'binary-pass-through';
    let charactersCharged = 0;
    let pdfPayload = null;
    let pdfSidecar = null;
    let pdfPageCount = null;

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
          pdfSidecar = pdfResult.sidecar || null;
          pdfPageCount = pdfResult.pageCount || null;
          if (pdfResult.pdf) {
            pdfPayload = pdfResult.pdf;
            // Placeholder so storeTranslationAssets creates the directory and metadata.
            // The Electron main process overwrites this with the real PDF it renders.
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
      // Persist the original + sidecar only for reformat-eligible PDFs (avoids storing every
      // Office/text original on-device). Both are gated on the PDF sidecar existing.
      inputBuffer: pdfSidecar ? inputBuffer : undefined,
      outputBuffer,
      sidecar: pdfSidecar || undefined,
      metadata: {
        mimeType,
        mode,
        inputBytes: inputBuffer.length,
        outputBytes: outputBuffer.length,
        charactersCharged,
        ...(pdfPageCount ? { pageCount: pdfPageCount } : {}),
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
      // pdf is the structured layout payload returned only for PDF translations:
      // { originalPdfBase64, pages:[ overlay | reflow ] }. The Electron main process renders it
      // to a real PDF — vector overlay for overlay pages, Chromium printToPDF for reflow pages.
      ...(pdfPayload !== null && { pdf: pdfPayload }),
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

    // Serve the newest AI artifact first (a later Language polish should beat an earlier Format
    // polish and vice versa), falling back to the original translation if a file is missing.
    const candidates = [
      metadata.formattedOutputKey && { key: metadata.formattedOutputKey, at: Date.parse(metadata.reformattedAt || 0) || 0 },
      metadata.languagePolishedOutputKey && { key: metadata.languagePolishedOutputKey, at: Date.parse(metadata.polishedAt || 0) || 0 },
    ].filter(Boolean).sort((a, b) => b.at - a.at);

    let buffer;
    let contentType;
    for (const candidate of candidates) {
      try { ({ buffer, contentType } = await getTranslationFileBuffer(candidate.key)); break; } catch {}
    }
    if (!buffer) ({ buffer, contentType } = await getTranslationFileBuffer(metadata.outputKey));

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${metadata.fileName}"`);
    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to load translation output file.' });
  }
}

// ── "Format With AI" — Azure Document Intelligence reformat ──────────────────────

const normalizeTM = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Converts a DI bounding polygon (flat [x1,y1,...], top-left origin, page unit = inches for PDF)
// into a pdf-lib run box (points, bottom-left origin) on a page `pageHeightIn` inches tall.
function diPolygonToRun(polygon, pageHeightIn) {
  const xs = polygon.filter((_, i) => i % 2 === 0);
  const ys = polygon.filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return {
    x: minX * 72,
    y: (pageHeightIn - maxY) * 72,   // bottom edge, flipped to bottom-left origin
    w: Math.max(0, (maxX - minX) * 72),
    h: Math.max(0, (maxY - minY) * 72),
  };
}

// Runs Azure DI Layout on a PDF and returns normalized pages + paragraphs (in reading order).
async function runDocumentIntelligenceLayout(pdfBuffer) {
  const { default: DocumentIntelligence, getLongRunningPoller, isUnexpected } =
    await import('@azure-rest/ai-document-intelligence');
  const client = DocumentIntelligence(DOCUMENT_INTELLIGENCE_ENDPOINT, { key: DOCUMENT_INTELLIGENCE_KEY });

  const initial = await client
    .path('/documentModels/{modelId}:analyze', 'prebuilt-layout')
    .post({ contentType: 'application/json', body: { base64Source: pdfBuffer.toString('base64') } });
  if (isUnexpected(initial)) {
    throw new Error(initial.body?.error?.message || `Document Intelligence analyze failed (${initial.status}).`);
  }

  const poller = getLongRunningPoller(client, initial);
  const analyzeResult = (await poller.pollUntilDone()).body?.analyzeResult || {};
  const pages = (analyzeResult.pages || []).map((p) => ({
    pageNumber: p.pageNumber, width: p.width, height: p.height, unit: p.unit,
  }));
  const paragraphs = (analyzeResult.paragraphs || [])
    .map((par) => {
      const region = par.boundingRegions?.[0];
      return region ? { content: par.content, page: region.pageNumber, polygon: region.polygon } : null;
    })
    .filter(Boolean);
  return { pages, paragraphs };
}

export async function reformatHandler(req, res) {
  try {
    const resolved = await resolveLicenseFromBearer(req);
    if (!resolved.valid || !resolved.record) {
      return res.status(401).json({ ok: false, error: resolved.reason || 'invalid-license' });
    }
    const { translationId, lang } = req.body || {};
    if (!translationId || !lang) {
      return res.status(400).json({ ok: false, error: 'translationId and lang are required.' });
    }
    if (!DOCUMENT_INTELLIGENCE_ENDPOINT || !DOCUMENT_INTELLIGENCE_KEY) {
      return res.status(503).json({ ok: false, error: 'di-not-configured', message: 'AI formatting is not configured.' });
    }

    const org = resolved.record.org;
    const meta = await getTranslationMetadata(org, lang, translationId);
    if (meta.mode !== 'pdf-translation' || !meta.sidecarKey || !meta.inputKey) {
      return res.status(400).json({
        ok: false,
        error: 'reformat-unavailable',
        message: 'This document cannot be AI-formatted (only PDFs translated by this app version).',
      });
    }

    const { buffer: originalPdf } = await getTranslationFileBuffer(meta.inputKey);
    const { buffer: sidecarBuf } = await getTranslationFileBuffer(meta.sidecarKey);
    const sidecar = JSON.parse(sidecarBuf.toString('utf8'));

    // Page count → flat cost, enforced before any DI call.
    const pageCount = Number(sidecar.pageCount || 0);
    if (!pageCount || !Array.isArray(sidecar.blocks)) {
      return res.status(400).json({ ok: false, error: 'reformat-unavailable', message: 'This document was translated by an older version and cannot be AI-formatted.' });
    }

    const cost = pageCount * REFORMAT_CHARS_PER_PAGE;
    const charLimit = Number(resolved.record.charLimit || 0);
    const charUsed = Number(resolved.record.characters || 0);
    const remaining = charLimit > 0 ? Math.max(0, charLimit - charUsed) : null;
    if (remaining != null && cost > remaining) {
      return res.status(402).json({
        ok: false,
        error: 'character-limit-exceeded',
        message: `AI formatting needs ${cost.toLocaleString()} characters (${pageCount} pages × 2,000) but your license only has ${remaining.toLocaleString()} remaining.`,
      });
    }

    // DI Layout → reading-ordered paragraphs with bounding polygons.
    const di = await runDocumentIntelligenceLayout(originalPdf);

    // Translation memory from the sidecar; re-place existing translations, translating only the
    // occasional DI segment that wasn't in the sidecar (covered by the flat per-page charge).
    const tm = new Map(sidecar.blocks.map((b) => [normalizeTM(b.source), { translated: b.translated, fontSize: b.fontSize }]));
    const targetLanguage = meta.targetLanguage || lang;

    const runsByPage = new Map();
    for (const para of di.paragraphs) {
      if (!para.content || !para.content.trim()) continue;
      const pageInfo = di.pages.find((pg) => pg.pageNumber === para.page);
      if (!pageInfo || !para.polygon) continue;

      const hit = tm.get(normalizeTM(para.content));
      let translated;
      let fontSize;
      if (hit) {
        translated = hit.translated;
        fontSize = hit.fontSize;
      } else {
        [translated] = await callAzureTranslate([para.content], targetLanguage, '');
      }
      const box = diPolygonToRun(para.polygon, pageInfo.height);
      if (!fontSize) fontSize = Math.max(8, Math.min(14, box.h || 12));

      if (!runsByPage.has(para.page)) runsByPage.set(para.page, []);
      runsByPage.get(para.page).push({ ...box, fontSize, translated });
    }

    const pages = [];
    for (let p = 1; p <= pageCount; p++) {
      pages.push({ mode: 'overlay', runs: runsByPage.get(p) || [] });
    }

    // Charge the flat per-page cost (DI succeeded; render happens on the Electron side next).
    const usageRecord = await incrementLicenseUsage(resolved.licenseKey, 0, cost);

    const formattedOutputKey = `translations/output/${org}/${lang}/${translationId}/ai-formatted-${meta.fileName}`;
    await updateTranslationMetadata(org, lang, translationId, {
      formattedOutputKey,
      reformattedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true,
      formattedOutputKey,
      pages: pageCount,
      charactersCharged: cost,
      pdf: { originalPdfBase64: originalPdf.toString('base64'), pages, targetLanguage },
      usage: {
        requests: Number(usageRecord.requests || 0),
        limit: Number(usageRecord.limit || 0),
        characters: Number(usageRecord.characters || 0),
        charLimit: Number(usageRecord.charLimit || 0),
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'AI formatting failed.' });
  }
}

// Modes whose output can be run through the AI Language Polish. PDF additionally requires a
// sidecar (the polish rewrites sidecar segments and re-renders); binary pass-throughs can't be
// polished at all.
const POLISHABLE_MODES = new Set([
  'pdf-translation', 'docx-translation', 'pptx-translation', 'xlsx-translation',
  'epub-translation', 'srt-translation', 'vtt-translation', 'azure-text-translation',
]);

// Splits plain text into ~maxLen chunks on line boundaries (separators stay inside chunks, so
// joining the polished chunks with '' reassembles the document).
function splitTextIntoChunks(text, maxLen) {
  const pieces = String(text).split(/(\r?\n)/);
  const chunks = [];
  let cur = '';
  for (const piece of pieces) {
    if (cur && cur.length + piece.length > maxLen) { chunks.push(cur); cur = ''; }
    cur += piece;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [''];
}

// "AI Language Polish" — passes the already-translated output through Azure OpenAI so the wording
// reads natively. No re-translation; charged at pages × 1,000 characters (pages estimated from
// text volume for non-PDF formats). Non-destructive: writes a lang-polished output file.
export async function polishHandler(req, res) {
  try {
    const resolved = await resolveLicenseFromBearer(req);
    if (!resolved.valid || !resolved.record) {
      return res.status(401).json({ ok: false, error: resolved.reason || 'invalid-license' });
    }
    const { translationId, lang } = req.body || {};
    if (!translationId || !lang) {
      return res.status(400).json({ ok: false, error: 'translationId and lang are required.' });
    }
    if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_KEY) {
      return res.status(503).json({ ok: false, error: 'polish-not-configured', message: 'AI language polishing is not configured.' });
    }

    const org = resolved.record.org;
    const meta = await getTranslationMetadata(org, lang, translationId);
    const mode = String(meta.mode || '');
    if (!POLISHABLE_MODES.has(mode) || (mode === 'pdf-translation' && !meta.sidecarKey)) {
      return res.status(400).json({
        ok: false,
        error: 'polish-unavailable',
        message: 'This document cannot be language-polished (unsupported type or translated by an older version).',
      });
    }

    const charLimit = Number(resolved.record.charLimit || 0);
    const charUsed = Number(resolved.record.characters || 0);
    const remaining = charLimit > 0 ? Math.max(0, charLimit - charUsed) : null;

    // Text-volume charging for non-PDF formats: the transform sees every segment before any
    // OpenAI call, accumulates the char total, and enforces the budget on the derived page cost.
    let computedCost = null;
    const seen = { chars: 0 };
    const stripMarkup = (s) => String(s).replace(/<[^>]+>/g, '');
    const budgetedPolish = async (texts) => {
      seen.chars += texts.reduce((sum, t) => sum + stripMarkup(t).length, 0);
      computedCost = Math.max(1, Math.ceil(seen.chars / POLISH_PAGE_ESTIMATE_CHARS)) * POLISH_CHARS_PER_PAGE;
      if (remaining != null && computedCost > remaining) throw new CharLimitError(computedCost);
      return callAzureOpenAIPolish(texts);
    };

    const targetLanguage = meta.targetLanguage || lang;
    let pdfRenderPayload = null;
    let polishedBuffer = null;

    if (mode === 'pdf-translation') {
      const { buffer: sidecarBuf } = await getTranslationFileBuffer(meta.sidecarKey);
      const sidecar = JSON.parse(sidecarBuf.toString('utf8'));
      if (!sidecar.pageCount || !Array.isArray(sidecar.blocks)) {
        return res.status(400).json({ ok: false, error: 'polish-unavailable', message: 'This document was translated by an older version and cannot be polished.' });
      }

      computedCost = sidecar.pageCount * POLISH_CHARS_PER_PAGE;
      if (remaining != null && computedCost > remaining) {
        return res.status(402).json({
          ok: false,
          error: 'character-limit-exceeded',
          message: `AI language polishing needs ${computedCost.toLocaleString()} characters (${sidecar.pageCount} pages × 1,000) but your license only has ${remaining.toLocaleString()} remaining.`,
        });
      }

      const polished = await callAzureOpenAIPolish(sidecar.blocks.map((b) => b.translated));
      sidecar.blocks.forEach((b, i) => { b.translated = polished[i] ?? b.translated; });

      // Rebuild the render payload using the original per-page overlay/reflow routing.
      const modeByPage = new Map((sidecar.pages || []).map((p) => [p.page, p.mode]));
      const blocksByPage = new Map();
      for (const b of sidecar.blocks) {
        if (!blocksByPage.has(b.page)) blocksByPage.set(b.page, []);
        blocksByPage.get(b.page).push(b);
      }

      if ((sidecar.pages || []).every((p) => p.mode === 'reflow')) {
        pdfRenderPayload = { allReflowHtml: buildPdfHtml(sidecar.blocks, targetLanguage), targetLanguage };
      } else {
        if (!meta.inputKey) {
          return res.status(400).json({ ok: false, error: 'polish-unavailable', message: 'The original PDF is no longer available for this document.' });
        }
        const { buffer: originalPdf } = await getTranslationFileBuffer(meta.inputKey);
        const pages = [];
        for (let p = 1; p <= sidecar.pageCount; p++) {
          const blocks = blocksByPage.get(p) || [];
          if (modeByPage.get(p) === 'overlay') {
            pages.push({
              mode: 'overlay',
              runs: blocks.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, fontSize: b.fontSize, translated: b.translated })),
            });
          } else {
            pages.push({ mode: 'reflow', html: buildPdfHtml(blocks, targetLanguage) });
          }
        }
        pdfRenderPayload = { originalPdfBase64: originalPdf.toString('base64'), pages, targetLanguage };
      }

      // Persist the polished sidecar so a later Format polish (DI) composes on the polished text.
      await writeTranslationFile(meta.sidecarKey, Buffer.from(JSON.stringify(sidecar)));
    } else {
      const { buffer: outBuf } = await getTranslationFileBuffer(meta.outputKey);

      if (mode === 'docx-translation') {
        const zip = new PizZip(outBuf);
        await translateZipParts(zip, /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/, DOCX_CFG, targetLanguage, '', null, budgetedPolish);
        polishedBuffer = Buffer.from(zip.generate({ type: 'nodebuffer' }));
      } else if (mode === 'pptx-translation') {
        const zip = new PizZip(outBuf);
        await translateZipParts(zip, /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+|diagrams\/data\d+)\.xml$/, PPTX_CFG, targetLanguage, '', null, budgetedPolish);
        polishedBuffer = Buffer.from(zip.generate({ type: 'nodebuffer' }));
      } else if (mode === 'xlsx-translation') {
        const zip = new PizZip(outBuf);
        await translateZipParts(zip, /^xl\/sharedStrings\.xml$/, XLSX_CFG, targetLanguage, '', null, budgetedPolish);
        await translateZipParts(zip, /^xl\/worksheets\/sheet\d+\.xml$/, XLSX_INLINE_CFG, targetLanguage, '', null, budgetedPolish);
        polishedBuffer = Buffer.from(zip.generate({ type: 'nodebuffer' }));
      } else if (mode === 'epub-translation') {
        ({ buffer: polishedBuffer } = await translateEpub(outBuf, targetLanguage, '', null, budgetedPolish));
      } else if (mode === 'srt-translation') {
        ({ buffer: polishedBuffer } = await translateSrt(outBuf, targetLanguage, '', null, budgetedPolish));
      } else if (mode === 'vtt-translation') {
        ({ buffer: polishedBuffer } = await translateVtt(outBuf, targetLanguage, '', null, budgetedPolish));
      } else {
        // azure-text-translation: whole-file text polish in line-bounded chunks.
        const text = outBuf.toString('utf8');
        if (!text.trim()) {
          return res.status(400).json({ ok: false, error: 'polish-unavailable', message: 'This document has no text to polish.' });
        }
        const polished = await budgetedPolish(splitTextIntoChunks(text, 6000));
        polishedBuffer = Buffer.from(polished.join(''), 'utf8');
      }

      if (computedCost == null) {
        return res.status(400).json({ ok: false, error: 'polish-unavailable', message: 'This document has no text to polish.' });
      }
    }

    const usageRecord = await incrementLicenseUsage(resolved.licenseKey, 0, computedCost);

    const languagePolishedOutputKey = `translations/output/${org}/${lang}/${translationId}/lang-polished-${meta.fileName}`;
    if (polishedBuffer) {
      await writeTranslationFile(languagePolishedOutputKey, polishedBuffer);
    }
    await updateTranslationMetadata(org, lang, translationId, {
      languagePolishedOutputKey,
      polishedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true,
      languagePolishedOutputKey,
      charactersCharged: computedCost,
      ...(pdfRenderPayload && { pdf: pdfRenderPayload }),
      usage: {
        requests: Number(usageRecord.requests || 0),
        limit: Number(usageRecord.limit || 0),
        characters: Number(usageRecord.characters || 0),
        charLimit: Number(usageRecord.charLimit || 0),
      },
    });
  } catch (error) {
    if (error instanceof CharLimitError) {
      return res.status(402).json({
        ok: false,
        error: 'character-limit-exceeded',
        message: `AI language polishing needs ${error.rawChars.toLocaleString()} characters but your license does not have enough remaining.`,
      });
    }
    return res.status(500).json({ ok: false, error: error.message || 'AI language polishing failed.' });
  }
}
