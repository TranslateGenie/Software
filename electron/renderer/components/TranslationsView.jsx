/**
 * TranslationsView.jsx — Browse, download, and AI-polish translated files.
 * Polls the local Express helper for new results. Documents are stored permanently in the
 * user's Documents/Translate Genie folder (open it with the folder button); the premium
 * "AI Polish" dropdown offers Language polish (all types) and Format polish (PDF only).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AZURE_LANGUAGES, getLangLabel } from '../lib/azureLanguages.js';

const POLL_INTERVAL_MS = 30_000;

const THUMB_EXT = new Set(['pdf', 'docx', 'pptx', 'xlsx']);

const LANGUAGE_POLISH_CHARS_PER_PAGE = 1000;
const FORMAT_POLISH_CHARS_PER_PAGE = 2000;
// Non-PDF documents have no page count; a "page" is estimated as this many characters.
const PAGE_ESTIMATE_CHARS = 3000;

function getThumbClass(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  return `file-thumb file-thumb--${THUMB_EXT.has(ext) ? ext : 'default'}`;
}

function getExtLabel(fileName) {
  return fileName.split('.').pop().toUpperCase();
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Pages used for cost display: real page count for PDFs, text-volume estimate otherwise.
function estimatePages(file) {
  if (file.pageCount > 0) return { pages: file.pageCount, estimated: false };
  const pages = Math.max(1, Math.ceil((file.charactersCharged || 0) / PAGE_ESTIMATE_CHARS));
  return { pages, estimated: true };
}

function Modal({ title, onClose, closeDisabled, children }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={() => { if (!closeDisabled) onClose(); }}
    >
      <div
        className="card"
        style={{ maxWidth: 480, width: '100%', maxHeight: '80vh', overflowY: 'auto', margin: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <p className="card__title" style={{ marginBottom: 0 }}>{title}</p>
          <button className="btn btn--secondary btn--sm" onClick={onClose} disabled={closeDisabled} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function TranslationsView({ onStatus }) {
  const [activeLang, setActiveLang] = useState('en');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [alert, setAlert] = useState(null);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [modal, setModal] = useState(null); // { type: 'info' | 'language' | 'format', file? }
  const [busyId, setBusyId] = useState(null);

  const fetchTranslations = useCallback(async (lang) => {
    const target = lang ?? activeLang;
    setLoading(true);
    onStatus('Refreshing translations…', 'warn');
    try {
      const items = await window.mdas.listTranslations(target);
      setFiles(Array.isArray(items) ? items : []);
      setLastRefresh(new Date());
      onStatus('Translations refreshed', 'ok');
    } catch (err) {
      setAlert({ type: 'error', text: `Failed to fetch translations: ${err.message}` });
      onStatus('Error fetching translations', 'error');
    } finally {
      setLoading(false);
    }
  }, [activeLang, onStatus]);

  useEffect(() => {
    fetchTranslations(activeLang);
    const timer = setInterval(() => fetchTranslations(activeLang), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activeLang, fetchTranslations]);

  const handleLangChange = (e) => {
    setActiveLang(e.target.value);
    setFiles([]);
    setOpenMenuId(null);
  };

  const handleOpenFolder = async () => {
    try {
      await window.mdas.openStorageFolder(activeLang);
    } catch (err) {
      setAlert({ type: 'error', text: `Could not open folder: ${err.message}` });
    }
  };

  const handleDownload = async (file) => {
    onStatus(`Downloading ${file.name}…`, 'warn');
    try {
      const { content, encoding } = await window.mdas.downloadFile({
        translationId: file.id,
        lang: activeLang,
      });

      const base64 = encoding === 'base64' ? content.replace(/\n/g, '') : btoa(content);
      const savePath = await window.mdas.saveFileDialog(file.name);
      if (!savePath) return;

      await window.mdas.writeFile(savePath, base64);
      onStatus(`Saved ${file.name}`, 'ok');
    } catch (err) {
      setAlert({ type: 'error', text: `Download failed: ${err.message}` });
      onStatus('Download error', 'error');
    }
  };

  const runPolish = async (kind, file) => {
    setModal(null);
    setBusyId(file.id);
    const label = kind === 'language' ? 'Language polish' : 'Format polish';
    onStatus(`${label} running for ${file.name}… this can take a minute`, 'warn');
    try {
      const result = kind === 'language'
        ? await window.mdas.polishLanguage({ translationId: file.id, lang: activeLang })
        : await window.mdas.reformatWithAI({ translationId: file.id, lang: activeLang });
      onStatus(`${label} complete (${Number(result?.charactersCharged || 0).toLocaleString()} characters used)`, 'ok');
      await fetchTranslations(activeLang);
    } catch (err) {
      setAlert({ type: 'error', text: `${label} failed: ${err.message}` });
      onStatus(`${label} failed`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const renderInfoModal = () => (
    <Modal title="✨ What is AI Polish?" onClose={() => setModal(null)}>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p>
          AI Polish upgrades a document you have already translated — your translation is never
          re-run and never re-charged. Each polish creates an improved version of the file, and
          your existing translation is kept too.
        </p>
        <p>
          <strong style={{ color: 'var(--text)' }}>💬 Language</strong> — rewrites the translated text so
          it reads as if written by a native speaker, removing that &ldquo;machine translated&rdquo;
          feel. Works on every supported document type.
          <br />
          <strong>Cost: {LANGUAGE_POLISH_CHARS_PER_PAGE.toLocaleString()} characters per page.</strong>
        </p>
        <p>
          <strong style={{ color: 'var(--text)' }}>📐 Format</strong> — rebuilds the document&rsquo;s
          layout with AI so it matches the original as closely as possible: columns, tables, and
          reading order. Available for PDF documents.
          <br />
          <strong>Cost: {FORMAT_POLISH_CHARS_PER_PAGE.toLocaleString()} characters per page.</strong>
        </p>
        <p>
          Costs come out of your license&rsquo;s character balance and are shown before anything runs.
          Tip: run Language polish before Format polish — the layout rebuild will then use your
          polished wording.
        </p>
      </div>
    </Modal>
  );

  const renderConfirmModal = () => {
    const { type, file } = modal;
    const isLanguage = type === 'language';
    const rate = isLanguage ? LANGUAGE_POLISH_CHARS_PER_PAGE : FORMAT_POLISH_CHARS_PER_PAGE;
    const { pages, estimated } = estimatePages(file);
    const cost = pages * rate;

    return (
      <Modal title={isLanguage ? '💬 AI Language Polish' : '📐 AI Format Polish'} onClose={() => setModal(null)}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ wordBreak: 'break-word' }}><strong style={{ color: 'var(--text)' }}>{file.name}</strong></p>
          <p>
            {isLanguage
              ? 'Rewrites this document’s translated text to read naturally, as if written by a native speaker. The translation itself is not re-run.'
              : 'Re-lays out this translated document with AI to closely match the original’s formatting — columns, tables, and reading order. Best for complex documents where standard formatting falls short. The translation itself is not re-run.'}
          </p>
          <p>This creates a new, improved version. Your current file is kept.</p>
          <div style={{ background: 'rgba(13,76,148,0.10)', border: '1px solid var(--brand)', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: 'var(--text)' }}>
            <strong>
              Cost: {pages.toLocaleString()} page{pages === 1 ? '' : 's'} × {rate.toLocaleString()} = {cost.toLocaleString()} characters
              {estimated ? ' (estimated)' : ''}
            </strong>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
            <button className="btn btn--secondary btn--sm" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn--primary btn--sm" onClick={() => runPolish(type, file)}>
              {isLanguage ? 'Polish Language' : 'Polish Format'}
            </button>
          </div>
        </div>
      </Modal>
    );
  };

  return (
    <div>
      {alert && (
        <div className={`alert alert--${alert.type}`} onClick={() => setAlert(null)} style={{ cursor: 'pointer' }}>
          {alert.text}
        </div>
      )}

      {modal?.type === 'info' && renderInfoModal()}
      {(modal?.type === 'language' || modal?.type === 'format') && renderConfirmModal()}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <p className="card__title" style={{ marginBottom: 0 }}>File History</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {lastRefresh && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Updated {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <button
              className="btn btn--secondary btn--sm"
              onClick={() => fetchTranslations(activeLang)}
              disabled={loading}
            >
              {loading ? <span className="spinner" /> : '↻ Refresh'}
            </button>
            <button
              className="btn btn--secondary btn--sm"
              onClick={handleOpenFolder}
              title="Open your translated documents folder"
            >
              📁 Open Folder
            </button>
          </div>
        </div>

        {/* Language picker */}
        <div className="lang-row" style={{ marginBottom: 16 }}>
          <div className="lang-field">
            <span className="lang-label">Show translations to</span>
            <select
              className="lang-select"
              value={activeLang}
              onChange={handleLangChange}
            >
              {AZURE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* File preview grid */}
        {files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">📭</div>
            <p>No translated files yet for {getLangLabel(activeLang)}.</p>
            <p style={{ fontSize: 12, marginTop: 6 }}>
              Upload documents and wait for the local translation helper to process them.
            </p>
          </div>
        ) : (
          <div className="translation-grid">
            {files.map((file) => (
              <div key={file.sha ?? file.id ?? file.name} className="translation-card">
                <div className={getThumbClass(file.name)}>
                  {getExtLabel(file.name)}
                </div>
                <div className="translation-card__lang">{getLangLabel(activeLang)}</div>
                <div className="translation-card__name" title={file.name}>
                  {file.name}
                </div>
                {(file.createdAt ?? file.uploadedAt ?? file.date) && (
                  <div className="translation-card__date">
                    {formatDate(file.createdAt ?? file.uploadedAt ?? file.date)}
                  </div>
                )}
                {(file.aiPolished || file.aiFormatted) && (
                  <div className="translation-card__date" style={{ color: 'var(--brand)', fontWeight: 600 }}>
                    {file.aiPolished && <span title="Language polished">✨ Polished </span>}
                    {file.aiFormatted && <span title="Layout rebuilt with AI">✨ Formatted</span>}
                  </div>
                )}
                <div className="translation-card__actions" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={() => handleDownload(file)}
                    disabled={busyId === file.id}
                  >
                    ⬇ Download
                  </button>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      className="btn btn--secondary btn--sm"
                      onClick={() => setOpenMenuId(openMenuId === file.id ? null : file.id)}
                      disabled={busyId === file.id || !file.polishEligible}
                      title={file.polishEligible ? 'AI Polish options' : 'AI Polish is not available for this document'}
                    >
                      {busyId === file.id ? <span className="spinner" /> : '✨ AI Polish ▾'}
                    </button>
                    <button
                      onClick={() => setModal({ type: 'info' })}
                      title="What is AI Polish?"
                      aria-label="About AI Polish"
                      style={{
                        border: 'none', background: 'transparent', color: 'var(--text-muted)',
                        cursor: 'pointer', fontSize: 14, padding: 2, lineHeight: 1,
                      }}
                    >
                      ⓘ
                    </button>
                    {openMenuId === file.id && (
                      <>
                        <div
                          style={{ position: 'fixed', inset: 0, zIndex: 900 }}
                          onClick={() => setOpenMenuId(null)}
                        />
                        <div
                          className="card"
                          style={{
                            position: 'absolute', top: '100%', left: 0, zIndex: 901, marginTop: 4,
                            padding: 6, minWidth: 150, display: 'flex', flexDirection: 'column', gap: 4,
                            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
                          }}
                        >
                          <button
                            className="btn btn--secondary btn--sm"
                            style={{ width: '100%' }}
                            onClick={() => { setOpenMenuId(null); setModal({ type: 'language', file }); }}
                          >
                            💬 Language
                          </button>
                          <button
                            className="btn btn--secondary btn--sm"
                            style={{ width: '100%', opacity: file.reformatEligible ? 1 : 0.45 }}
                            disabled={!file.reformatEligible}
                            title={file.reformatEligible ? 'Rebuild this PDF’s layout with AI' : 'Format polish is available for PDF documents only'}
                            onClick={() => { setOpenMenuId(null); setModal({ type: 'format', file }); }}
                          >
                            📐 Format
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <p className="card__title">Your documents are saved permanently</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Translated files are stored in your <strong>Documents › Translate Genie</strong> folder and
          are never deleted automatically — use <strong>📁 Open Folder</strong> to manage them yourself.
          The app checks for new translations every {POLL_INTERVAL_MS / 1000} seconds.
        </p>
      </div>
    </div>
  );
}
