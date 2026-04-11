/**
 * FileList.jsx — Displays queued files with their upload status.
 */

import React from 'react';

const FILE_ICONS = {
  docx: '📝',
  pptx: '📊',
  xlsx: '📈',
  pdf: '📄',
};

function getIcon(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  return FILE_ICONS[ext] ?? '📁';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_LABELS = {
  pending: 'Pending',
  uploading: 'Uploading…',
  uploaded: 'Uploaded ✓',
  error: 'Error',
};

export default function FileList({ files, onRemove }) {
  if (files.length === 0) return null;

  return (
    <div className="file-list">
      {files.map((entry) => (
        <div key={entry.id} className="file-item">
          <span className="file-item__icon">{getIcon(entry.file.name)}</span>
          <div className="file-item__info">
            <div className="file-item__name" title={entry.file.name}>
              {entry.file.name}
            </div>
            <div className="file-item__size">{formatBytes(entry.file.size)}</div>
          </div>
          <span className={`file-item__status status--${entry.status}`}>
            {entry.status === 'uploading' && (
              <span className="spinner" style={{ marginRight: 6 }} />
            )}
            {STATUS_LABELS[entry.status] ?? entry.status}
          </span>
          {entry.error && (
            <span
              title={entry.error}
              style={{ fontSize: 16, cursor: 'help' }}
            >
              ⚠️
            </span>
          )}
          {entry.status === 'pending' && onRemove && (
            <button
              className="btn btn--secondary btn--sm"
              onClick={() => onRemove(entry.id)}
              title="Remove"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
