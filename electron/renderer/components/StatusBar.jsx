/**
 * StatusBar.jsx — Bottom status bar showing the current app status.
 */

import React from 'react';

export default function StatusBar({ message, level }) {
  return (
    <footer className="status-bar">
      <span className={`status-dot${level === 'warn' ? ' warn' : level === 'error' ? ' error' : ''}`} />
      <span>{message}</span>
    </footer>
  );
}
