/**
 * App.jsx — Root React component
 * Manages top-level navigation between Upload, Translations and Settings views.
 */

import React, { useEffect, useState } from 'react';
import LicenseView from './views/LicenseView.jsx';
import UploadView from './views/UploadView.jsx';
import TranslationsView from './views/TranslationsView.jsx';
import SettingsView from './views/SettingsView.jsx';
import LicenseManagementView from './views/LicenseManagementView.jsx';
import BugReportsView from './views/BugReportsView.jsx';
import StatusBar from './components/StatusBar.jsx';

const VIEWS = ['Upload', 'Translations', 'License', 'Bug Reports', 'Settings'];

function buildLicenseAlerts(session) {
  if (!session?.valid) {
    return [{ level: 'error', text: 'License is missing or invalid. Please activate a valid license key.' }];
  }

  const alerts = [];
  const expiresAt = Number(session.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    alerts.push({ level: 'error', text: 'Your license has expired. Renew to continue uninterrupted uploads.' });
  }

  const limit = Number(session.limit || 0);
  const requests = Number(session.requests || 0);
  const charLimit = Number(session.charLimit || 0);
  const characters = Number(session.characters || 0);
  const remainingRequests = Math.max(0, limit - requests);
  const remainingCharacters = Math.max(0, charLimit - characters);

  if (limit > 0 && remainingRequests > 0 && remainingRequests / limit < 0.1) {
    alerts.push({ level: 'warn', text: 'Your license is nearing its request limit. Renew soon to avoid interruptions.' });
  }

  if (charLimit > 0 && remainingCharacters > 0 && remainingCharacters / charLimit < 0.1) {
    alerts.push({ level: 'warn', text: 'Your license is nearing its character limit. Renew soon to avoid interruptions.' });
  }

  return alerts;
}

export default function App() {
  const [activeView, setActiveView] = useState('Upload');
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [statusLevel, setStatusLevel] = useState('ok'); // 'ok' | 'warn' | 'error'
  const [licenseSession, setLicenseSession] = useState({ valid: false });
  const [checkingLicense, setCheckingLicense] = useState(true);
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    window.mdas
      .getLicenseSession()
      .then((session) => {
        setLicenseSession(session ?? { valid: false });
        setAlerts(buildLicenseAlerts(session));
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
    setAlerts(buildLicenseAlerts({ valid: true, ...session }));
    setStatusMessage(`Licensed: ${session.org || 'org'} (${session.type || 'type'})`);
    setStatusLevel('ok');
  };

  const handleLicenseSessionUpdated = (session) => {
    setLicenseSession(session ?? { valid: false });
    setAlerts(buildLicenseAlerts(session));
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
        {alerts.length > 0 && (
          <div className="stack">
            {alerts.map((alert, idx) => (
              <div key={`${alert.level}-${idx}`} className={`alert alert--${alert.level}`}>
                {alert.text}
              </div>
            ))}
          </div>
        )}
        {activeView === 'Upload' && (
          <UploadView
            onStatus={updateStatus}
            licenseSession={licenseSession}
            onLicenseSessionUpdated={handleLicenseSessionUpdated}
          />
        )}
        {activeView === 'Translations' && <TranslationsView onStatus={updateStatus} />}
        {activeView === 'License' && (
          <LicenseManagementView
            onStatus={updateStatus}
            licenseSession={licenseSession}
            onLicenseSessionUpdated={handleLicenseSessionUpdated}
          />
        )}
        {activeView === 'Bug Reports' && <BugReportsView onStatus={updateStatus} />}
        {activeView === 'Settings' && <SettingsView onStatus={updateStatus} licenseSession={licenseSession} />}
      </main>

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <StatusBar message={statusMessage} level={statusLevel} />
    </div>
  );
}
