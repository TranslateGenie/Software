/**
 * SettingsView.jsx — Admin diagnostics and managed backend visibility.
 */

import React, { useState, useEffect } from 'react';

const ALL_LANGUAGES = [
  { code: 'en', label: '🇬🇧 English' },
  { code: 'zh', label: '🇨🇳 Chinese (Simplified)' },
  { code: 'es', label: '🇪🇸 Spanish' },
  { code: 'fr', label: '🇫🇷 French' },
  { code: 'de', label: '🇩🇪 German' },
  { code: 'ja', label: '🇯🇵 Japanese' },
  { code: 'ko', label: '🇰🇷 Korean' },
  { code: 'ar', label: '🇸🇦 Arabic' },
  { code: 'pt', label: '🇧🇷 Portuguese' },
];

const DEFAULT_SETTINGS = {
  targetLanguages: ['en', 'zh'],
  customLanguageCode: '',
  license: null,
};

export default function SettingsView({ onStatus, licenseSession }) {
  const [form, setForm] = useState(DEFAULT_SETTINGS);
  const [license, setLicense] = useState(null);
  const [appConfig, setAppConfig] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  // Load persisted settings on mount
  useEffect(() => {
    window.mdas
      .getSettings()
      .then((s) => setForm({ ...DEFAULT_SETTINGS, ...s }))
      .catch(() => {});

    window.mdas
      .getLicenseSession()
      .then((session) => setLicense(session ?? null))
      .catch(() => setLicense(null));

    window.mdas
      .getPublicConfig()
      .then(setAppConfig)
      .catch(() => setAppConfig(null));
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

  const effectiveLicense = licenseSession?.valid ? licenseSession : license;
  const reqUsed = Number(effectiveLicense?.requests ?? form.license?.requests ?? 0);
  const reqLimit = Number(effectiveLicense?.limit ?? form.license?.limit ?? 0);
  const charUsed = Number(effectiveLicense?.characters ?? form.license?.characters ?? 0);
  const charLimit = Number(effectiveLicense?.charLimit ?? form.license?.charLimit ?? 0);

  return (
    <div>
      {saved && (
        <div className="alert alert--success">Settings saved successfully.</div>
      )}
      {error && (
        <div className="alert alert--error">{error}</div>
      )}

      <div className="card">
        <p className="card__title">Managed Backend</p>
        <div className="settings-form">
          <div className="form-field">
            <label>Repository</label>
            <input type="text" readOnly value={appConfig?.backendRepo || 'Not configured'} />
          </div>
          <div className="form-field">
            <label>License API</label>
            <input type="text" readOnly value={appConfig?.licenseApiBaseUrl || 'Not configured'} />
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
        <div className="form-field" style={{ marginTop: 16 }}>
          <label htmlFor="customLanguageCode">
            Custom Language Code{' '}
            <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              (valid BCP-47 code, e.g. <code>ru</code>, <code>hi</code>, <code>tr</code>)
            </span>
          </label>
          <input
            id="customLanguageCode"
            type="text"
            value={form.customLanguageCode ?? ''}
            onChange={(e) => handleChange('customLanguageCode', e.target.value.trim().toLowerCase())}
            placeholder="e.g. ru"
            maxLength={10}
            style={{ maxWidth: 160 }}
          />
          <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            Translated output will be saved in <code>translations/third/</code>. Leave blank to
            disable the custom language slot.
          </small>
        </div>
      </div>

      {/* ── Subscription (placeholder) ─────────────────────────────── */}
      <div className="card">
        <p className="card__title">Subscription</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 28 }}>🔓</span>
          <div>
            <p style={{ fontWeight: 600 }}>{effectiveLicense?.org || form.license?.org || 'Unknown Org'} — {effectiveLicense?.type || form.license?.type || 'Unknown Type'}</p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Requests: {reqUsed} / {reqLimit}
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Characters: {charUsed} / {charLimit}
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <p className="card__title">Security Model</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
          End users do not provide GitHub tokens, repository settings, or Azure secrets. This desktop
          app uses developer-managed infrastructure through GitHub App authentication.
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          License sessions are stored in OS credential storage and periodically revalidated.
        </p>
      </div>

      <button className="btn btn--primary" onClick={handleSave}>
        Save Settings
      </button>
    </div>
  );
}
