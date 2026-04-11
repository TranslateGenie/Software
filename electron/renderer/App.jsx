/**
 * App.jsx — Root React component
 * Manages top-level navigation between Upload, Translations and Settings views.
 */

import React, { useState } from 'react';
import UploadView from './components/UploadView.jsx';
import TranslationsView from './components/TranslationsView.jsx';
import SettingsView from './components/SettingsView.jsx';
import StatusBar from './components/StatusBar.jsx';

const VIEWS = ['Upload', 'Translations', 'Settings'];

export default function App() {
  const [activeView, setActiveView] = useState('Upload');
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [statusLevel, setStatusLevel] = useState('ok'); // 'ok' | 'warn' | 'error'

  const updateStatus = (message, level = 'ok') => {
    setStatusMessage(message);
    setStatusLevel(level);
  };

  return (
    <div className="app">
      {/* ── Header / Navigation ─────────────────────────────────────── */}
      <header className="app__header">
        <span className="app__logo">📄 MDAS</span>
        <nav className="app__nav">
          {VIEWS.map((view) => (
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
        {activeView === 'Upload' && <UploadView onStatus={updateStatus} />}
        {activeView === 'Translations' && <TranslationsView onStatus={updateStatus} />}
        {activeView === 'Settings' && <SettingsView onStatus={updateStatus} />}
      </main>

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <StatusBar message={statusMessage} level={statusLevel} />
    </div>
  );
}
