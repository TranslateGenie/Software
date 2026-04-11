/**
 * TranslationsView.jsx — Browse and download translated files.
 * Polls GitHub for new results and lets the user download them.
 */

import React, { useState, useEffect, useCallback } from 'react';

const LANG_LABELS = {
  en: '🇬🇧 English',
  zh: '🇨🇳 Chinese',
  third: '🌐 Custom Language',
};

const POLL_INTERVAL_MS = 30_000; // poll every 30 seconds

export default function TranslationsView({ onStatus }) {
  const [activeLang, setActiveLang] = useState('en');
  const [filesByLang, setFilesByLang] = useState({ en: [], zh: [], third: [] });
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [alert, setAlert] = useState(null);
  const [settings, setSettings] = useState(null);

  // Load settings so we can use repoOwner / repoName for downloads
  useEffect(() => {
    window.mdas.getSettings().then(setSettings).catch(() => {});
  }, []);

  const fetchTranslations = useCallback(async () => {
    setLoading(true);
    onStatus('Refreshing translations…', 'warn');
    try {
      const [en, zh, third] = await Promise.all([
        window.mdas.listTranslations('en'),
        window.mdas.listTranslations('zh'),
        window.mdas.listTranslations('third'),
      ]);
      setFilesByLang({ en, zh, third });
      setLastRefresh(new Date());
      onStatus('Translations refreshed', 'ok');
    } catch (err) {
      setAlert({ type: 'error', text: `Failed to fetch translations: ${err.message}` });
      onStatus('Error fetching translations', 'error');
    } finally {
      setLoading(false);
    }
  }, [onStatus]);

  // Initial fetch + auto-poll
  useEffect(() => {
    fetchTranslations();
    const timer = setInterval(fetchTranslations, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchTranslations]);

  const handleDownload = async (lang, file) => {
    if (!settings) return;
    onStatus(`Downloading ${file.name}…`, 'warn');
    try {
      const { content, encoding } = await window.mdas.downloadFile({
        repoOwner: settings.repoOwner,
        repoName: settings.repoName,
        filePath: `translations/${lang}/${file.name}`,
      });

      // content comes back as base64 from the GitHub API
      const base64 = encoding === 'base64' ? content.replace(/\n/g, '') : btoa(content);

      const savePath = await window.mdas.saveFileDialog(file.name);
      if (!savePath) return; // user cancelled

      await window.mdas.writeFile(savePath, base64);
      onStatus(`Saved ${file.name}`, 'ok');
    } catch (err) {
      setAlert({ type: 'error', text: `Download failed: ${err.message}` });
      onStatus('Download error', 'error');
    }
  };

  const currentFiles = filesByLang[activeLang] ?? [];

  return (
    <div>
      {alert && (
        <div className={`alert alert--${alert.type}`} onClick={() => setAlert(null)} style={{ cursor: 'pointer' }}>
          {alert.text}
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <p className="card__title" style={{ marginBottom: 0 }}>Translated Files</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {lastRefresh && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Updated {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <button
              className="btn btn--secondary btn--sm"
              onClick={fetchTranslations}
              disabled={loading}
            >
              {loading ? <span className="spinner" /> : '↻ Refresh'}
            </button>
          </div>
        </div>

        {/* Language tabs */}
        <div className="tabs">
          {Object.entries(LANG_LABELS).map(([lang, label]) => (
            <button
              key={lang}
              className={`tab${activeLang === lang ? ' active' : ''}`}
              onClick={() => setActiveLang(lang)}
            >
              {label}
              {filesByLang[lang]?.length > 0 && (
                <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>
                  ({filesByLang[lang].length})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* File grid */}
        {currentFiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">📭</div>
            <p>No translated files yet for {LANG_LABELS[activeLang]}.</p>
            <p style={{ fontSize: 12, marginTop: 6 }}>
              Upload documents and wait for GitHub Actions to process them.
            </p>
          </div>
        ) : (
          <div className="translation-grid">
            {currentFiles.map((file) => (
              <div key={file.sha ?? file.name} className="translation-card">
                <div className="translation-card__lang">{LANG_LABELS[activeLang]}</div>
                <div className="translation-card__name" title={file.name}>
                  {file.name}
                </div>
                <div className="translation-card__actions">
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={() => handleDownload(activeLang, file)}
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
