/**
 * SettingsView.jsx — Configure GitHub credentials, target languages,
 * and view subscription status.
 */

import React, { useState, useEffect } from 'react';

const ALL_LANGUAGES = [
  { code: 'en', label: '🇬🇧 English' },
  { code: 'zh', label: '🇨🇳 Chinese (Simplified)' },
  { code: 'third', label: '🌐 Third Language (configurable)' },
  { code: 'es', label: '🇪🇸 Spanish' },
  { code: 'fr', label: '🇫🇷 French' },
  { code: 'de', label: '🇩🇪 German' },
  { code: 'ja', label: '🇯🇵 Japanese' },
  { code: 'ko', label: '🇰🇷 Korean' },
  { code: 'ar', label: '🇸🇦 Arabic' },
  { code: 'pt', label: '🇧🇷 Portuguese' },
];

const DEFAULT_SETTINGS = {
  githubToken: '',
  repoOwner: '',
  repoName: '',
  targetLanguages: ['en', 'zh'],
};

export default function SettingsView({ onStatus }) {
  const [form, setForm] = useState(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  // Load persisted settings on mount
  useEffect(() => {
    window.mdas
      .getSettings()
      .then((s) => setForm({ ...DEFAULT_SETTINGS, ...s }))
      .catch(() => {});
  }, []);

  const handleChange = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  };

  const toggleLanguage = (code) => {
    setForm((prev) => {
      const langs = prev.targetLanguages.includes(code)
        ? prev.targetLanguages.filter((l) => l !== code)
        : [...prev.targetLanguages, code];
      return { ...prev, targetLanguages: langs };
    });
    setSaved(false);
  };

  const handleSave = async () => {
    setError(null);
    try {
      await window.mdas.saveSettings(form);
      setSaved(true);
      onStatus('Settings saved', 'ok');
    } catch (err) {
      setError(err.message);
      onStatus('Failed to save settings', 'error');
    }
  };

  return (
    <div>
      {saved && (
        <div className="alert alert--success">Settings saved successfully.</div>
      )}
      {error && (
        <div className="alert alert--error">{error}</div>
      )}

      {/* ── GitHub Credentials ─────────────────────────────────────── */}
      <div className="card">
        <p className="card__title">GitHub Integration</p>
        <div className="settings-form">
          <div className="form-field">
            <label htmlFor="githubToken">Personal Access Token</label>
            <input
              id="githubToken"
              type="password"
              value={form.githubToken}
              onChange={(e) => handleChange('githubToken', e.target.value)}
              placeholder="ghp_…"
              autoComplete="off"
            />
            <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              Requires <code>repo</code> scope. The token is stored locally and never committed.
            </small>
          </div>

          <div className="form-field">
            <label htmlFor="repoOwner">Repository Owner</label>
            <input
              id="repoOwner"
              type="text"
              value={form.repoOwner}
              onChange={(e) => handleChange('repoOwner', e.target.value)}
              placeholder="your-github-username-or-org"
            />
          </div>

          <div className="form-field">
            <label htmlFor="repoName">Repository Name</label>
            <input
              id="repoName"
              type="text"
              value={form.repoName}
              onChange={(e) => handleChange('repoName', e.target.value)}
              placeholder="your-repo-name"
            />
          </div>
        </div>
      </div>

      {/* ── Target Languages ───────────────────────────────────────── */}
      <div className="card">
        <p className="card__title">Target Languages</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
          Select which languages the translation pipeline should produce.
          These values are read by <code>scripts/translate-docs.js</code> via the{' '}
          <code>TARGET_LANGUAGES</code> workflow environment variable.
        </p>
        <div className="lang-chips">
          {ALL_LANGUAGES.map(({ code, label }) => (
            <button
              key={code}
              className={`lang-chip${form.targetLanguages.includes(code) ? ' selected' : ''}`}
              onClick={() => toggleLanguage(code)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Subscription (placeholder) ─────────────────────────────── */}
      <div className="card">
        <p className="card__title">Subscription</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 28 }}>🔓</span>
          <div>
            <p style={{ fontWeight: 600 }}>Free Plan</p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Unlimited translations via your own Azure API key. Pro plans with managed
              API credits coming soon.
            </p>
          </div>
        </div>
      </div>

      {/* ── Azure credentials note ─────────────────────────────────── */}
      <div className="card">
        <p className="card__title">Azure Translator Setup</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          The translation pipeline requires these GitHub Actions secrets in your repository:
        </p>
        <ul style={{ paddingLeft: 20, fontSize: 13, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li><code>AZURE_TRANSLATOR_KEY</code> — your Azure Cognitive Services key</li>
          <li><code>AZURE_TRANSLATOR_ENDPOINT</code> — e.g. <code>https://api.cognitive.microsofttranslator.com</code></li>
          <li><code>AZURE_TRANSLATOR_REGION</code> — e.g. <code>eastus</code></li>
        </ul>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
          Go to <em>Repository → Settings → Secrets and variables → Actions</em> to add them.
        </p>
      </div>

      <button className="btn btn--primary" onClick={handleSave}>
        Save Settings
      </button>
    </div>
  );
}
