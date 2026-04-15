/**
 * HomeView.jsx — Landing page for unlicensed users
 * Provides two paths: Enter existing license key or get a new license
 */

import React from 'react';

export default function HomeView({ onEnterLicense, onStatus }) {
  const handleGetLicense = () => {
    onStatus('Opening browser to download page...', 'ok');
    window.mdas.openExternalUrl('https://your-domain.com/download');
  };

  return (
    <div className="card" style={{ maxWidth: 540, margin: '6vh auto' }}>
      <p className="card__title">Welcome to Translate Genie</p>
      <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>
        Translate documents seamlessly with our desktop application. Get started by entering an existing license key or purchasing a new one.
      </p>

      <div style={{ display: 'flex', gap: 12, flexDirection: 'column' }}>
        <button
          className="btn btn--primary"
          onClick={onEnterLicense}
          style={{ width: '100%' }}
        >
          Enter License Key
        </button>
        <button
          className="btn"
          onClick={handleGetLicense}
          style={{ width: '100%' }}
        >
          Get a License
        </button>
      </div>

      <p style={{ marginTop: 24, fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center' }}>
        Already have a license key? Paste it above to activate the application.
      </p>
    </div>
  );
}
