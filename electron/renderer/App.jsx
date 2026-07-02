/**
 * App.jsx — Root React component
 * Manages top-level navigation between Upload, Translations and Settings views.
 */

import React, { useEffect, useState } from 'react';
import HomeView from './views/HomeView.jsx';
import LicenseView from './views/LicenseView.jsx';
import UploadView from './views/UploadView.jsx';
import TranslationsView from './views/TranslationsView.jsx';
import LicenseManagementView from './views/LicenseManagementView.jsx';
import BugReportsView from './views/BugReportsView.jsx';
import SiteView from './views/SiteView.jsx';
import StatusBar from './components/StatusBar.jsx';
import LogoImg from '../Logo.png';

const VIEWS = ['News', 'Upload', 'Translations', 'License', 'Bug Reports'];

function buildLicenseAlerts(session) {
  if (!session?.valid) {
    return [{ level: 'error', text: 'License is missing or invalid. Please activate a valid license key.' }];
  }

  const alerts = [];

  // Licenses are metered by characters only — no document/request limit and no time expiration.
  const charLimit = Number(session.charLimit || 0);
  const characters = Number(session.characters || 0);
  const remainingCharacters = Math.max(0, charLimit - characters);

  if (charLimit > 0 && remainingCharacters > 0 && remainingCharacters / charLimit < 0.1) {
    alerts.push({ level: 'warn', text: 'Your license is nearing its character limit. Renew soon to avoid interruptions.' });
  }

  return alerts;
}

export default function App() {
  const [activeView, setActiveView] = useState('News');
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [statusLevel, setStatusLevel] = useState('ok'); // 'ok' | 'warn' | 'error'
  const [licenseSession, setLicenseSession] = useState({ valid: false });
  const [checkingLicense, setCheckingLicense] = useState(true);
  const [alerts, setAlerts] = useState([]);
  const [isEnteringLicense, setIsEnteringLicense] = useState(false);
  const [updateState, setUpdateState] = useState({ status: 'idle', percent: 0 });

  useEffect(() => {
    window.mdas.onUpdateStatus((data) => {
      setUpdateState(data);
      if (data.status === 'up-to-date' || data.status === 'error') {
        setTimeout(() => setUpdateState({ status: 'idle', percent: 0 }), 4000);
      }
    });
    return () => window.mdas.removeUpdateStatusListener();
  }, []);

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
    if (!isEnteringLicense) {
      return (
        <div className="app">
          <main className="app__body">
            <HomeView
              onEnterLicense={() => setIsEnteringLicense(true)}
              onStatus={updateStatus}
            />
          </main>
          <StatusBar message={statusMessage} level={statusLevel} />
        </div>
      );
    }
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
        <span><img className="logoImg" src={LogoImg}/></span>
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
          <button
            className="nav-btn nav-btn--update"
            disabled={updateState.status === 'checking' || updateState.status === 'downloading'}
            onClick={() => updateState.status === 'ready'
              ? window.mdas.installUpdate()
              : window.mdas.checkForUpdates()
            }
          >
            {updateState.status === 'idle'      && 'Check Updates'}
            {updateState.status === 'checking'  && 'Checking…'}
            {updateState.status === 'up-to-date'&& 'Up to Date ✓'}
            {updateState.status === 'available' && 'Downloading…'}
            {updateState.status === 'downloading'&& `Downloading… ${updateState.percent}%`}
            {updateState.status === 'ready'     && 'Restart to Install'}
            {updateState.status === 'error'     && 'Update Failed'}
          </button>
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
        {activeView === 'News' && <SiteView />}
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
      </main>

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <StatusBar message={statusMessage} level={statusLevel} />
    </div>
  );
}
