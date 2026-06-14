/**
 * TranslationsView.jsx — Browse and download translated files.
 * Polls the local Express helper for new results and lets the user download them.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AZURE_LANGUAGES, getLangLabel } from '../lib/azureLanguages.js';

const POLL_INTERVAL_MS = 30_000;

const THUMB_EXT = new Set(['pdf', 'docx', 'pptx', 'xlsx']);

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

export default function TranslationsView({ onStatus }) {
  const [activeLang, setActiveLang] = useState('en');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [alert, setAlert] = useState(null);

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

  return (
    <div>
      {alert && (
        <div className={`alert alert--${alert.type}`} onClick={() => setAlert(null)} style={{ cursor: 'pointer' }}>
          {alert.text}
        </div>
      )}

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
                <div className="translation-card__actions">
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={() => handleDownload(file)}
                  >
                    ⬇ Download
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <p className="card__title">Auto-poll status</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          The app automatically checks for new translations every{' '}
          {POLL_INTERVAL_MS / 1000} seconds. You can also click{' '}
          <strong>↻ Refresh</strong> at any time.
        </p>
      </div>
    </div>
  );
}
