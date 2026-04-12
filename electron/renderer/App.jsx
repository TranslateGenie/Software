/**
 * App.jsx — Root React component
 * Manages top-level navigation between Upload, Translations and Settings views.
 */

import React, { useEffect, useState } from 'react';
import LicenseView from './views/LicenseView.jsx';
import UploadView from './views/UploadView.jsx';
import TranslationsView from './views/TranslationsView.jsx';
import SettingsView from './views/SettingsView.jsx';
import StatusBar from './components/StatusBar.jsx';

const VIEWS = ['Upload', 'Translations', 'Settings'];

export default function App() {
  const [activeView, setActiveView] = useState('Upload');
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [statusLevel, setStatusLevel] = useState('ok'); // 'ok' | 'warn' | 'error'
  const [licenseSession, setLicenseSession] = useState({ valid: false });
  const [checkingLicense, setCheckingLicense] = useState(true);

  useEffect(() => {
    window.mdas
      .getLicenseSession()
      .then((session) => {
        setLicenseSession(session ?? { valid: false });
        if (session?.valid) {
          setStatusMessage(`Licensed: ${session.org || 'org'} (${session.type || 'type'})`);
        } else if (session?.reason === 'limit-reached') {
          setStatusMessage('Your translation quota has been reached. Please purchase additional request packs.');
          setStatusLevel('error');
        }
      })
      .catch(() => setLicenseSession({ valid: false }))
      .finally(() => setCheckingLicense(false));
  }, []);

  const updateStatus = (message, level = 'ok') => {
    setStatusMessage(message);
    setStatusLevel(level);
  };

  const handleLicenseValidated = (session) => {
    setLicenseSession({ valid: true, ...session });
    setStatusMessage(`Licensed: ${session.org || 'org'} (${session.type || 'type'})`);
    setStatusLevel('ok');
  };

  const availableViews = VIEWS;

  if (checkingLicense) {
    return (
      <div className="app">
        <main className="app__body">
          <div className="card">
            <p className="card__title">Checking license</p>
            <p>Please wait while we validate your session.</p>
          </div>
        </main>
        <StatusBar message="Validating license" level="warn" />
      </div>
    );
  }

  if (!licenseSession?.valid) {
    return (
      <div className="app">
        <main className="app__body">
          <LicenseView onValidated={handleLicenseValidated} onStatus={updateStatus} />
        </main>
        <StatusBar message={statusMessage} level={statusLevel} />
      </div>
    );
  }

  return (
    <div className="app">
      {/* ── Header / Navigation ─────────────────────────────────────── */}
      <header className="app__header">
        <span className="app__logo">📄 MDAS</span>
        <nav className="app__nav">
          {availableViews.map((view) => (
            <button
              key={view}
              className={`nav-btn${activeView === view ? ' active' : ''}`}
              onClick={() => setActiveView(view)}
            >
              {view}
            </button>
          ))}
        </nav>
      </header>

      {/* ── Main body ───────────────────────────────────────────────── */}
      <main className="app__body">
        {activeView === 'Upload' && <UploadView onStatus={updateStatus} licenseSession={licenseSession} />}
        {activeView === 'Translations' && <TranslationsView onStatus={updateStatus} />}
        {activeView === 'Settings' && <SettingsView onStatus={updateStatus} licenseSession={licenseSession} />}
      </main>

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <StatusBar message={statusMessage} level={statusLevel} />
    </div>
  );
}
