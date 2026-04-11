/**
 * UploadView.jsx — Main upload screen.
 * Allows the user to drag-and-drop or browse for files, then upload to GitHub.
 */

import React, { useState, useCallback } from 'react';
import DropZone from './DropZone.jsx';
import FileList from './FileList.jsx';

let nextId = 1;

/** Read a File object and return its base64-encoded content. */
async function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is a data-URL like "data:...;base64,<data>"
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function UploadView({ onStatus }) {
  const [files, setFiles] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [alert, setAlert] = useState(null);

  const handleFilesAdded = useCallback((newFiles) => {
    const entries = newFiles.map((file) => ({
      id: nextId++,
      file,
      status: 'pending',
      error: null,
    }));
    setFiles((prev) => [...prev, ...entries]);
    setAlert(null);
    onStatus(`${entries.length} file(s) queued`);
  }, [onStatus]);

  const handleRemove = useCallback((id) => {
    setFiles((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const updateEntry = (id, updates) =>
    setFiles((prev) => prev.map((e) => (e.id === id ? { ...e, ...updates } : e)));

  const handleUploadAll = async () => {
    const pending = files.filter((e) => e.status === 'pending');
    if (pending.length === 0) return;

    setIsUploading(true);
    setAlert(null);
    onStatus('Uploading…', 'warn');

    let successCount = 0;
    let errorCount = 0;

    for (const entry of pending) {
      updateEntry(entry.id, { status: 'uploading', error: null });
      try {
        const base64Content = await readFileAsBase64(entry.file);
        await window.mdas.uploadFile({
          fileName: entry.file.name,
          base64Content,
        });
        updateEntry(entry.id, { status: 'uploaded' });
        successCount++;
      } catch (err) {
        updateEntry(entry.id, { status: 'error', error: err.message });
        errorCount++;
      }
    }

    setIsUploading(false);

    if (errorCount === 0) {
      setAlert({ type: 'success', text: `${successCount} file(s) uploaded successfully. GitHub Actions will now process them.` });
      onStatus(`${successCount} file(s) uploaded`, 'ok');
    } else {
      setAlert({ type: 'error', text: `${errorCount} file(s) failed to upload. Check your GitHub settings.` });
      onStatus(`${errorCount} upload error(s)`, 'error');
    }
  };

  const handleClearDone = () => {
    setFiles((prev) => prev.filter((e) => e.status === 'pending' || e.status === 'uploading'));
  };

  const pendingCount = files.filter((e) => e.status === 'pending').length;
  const hasDone = files.some((e) => e.status === 'uploaded' || e.status === 'error');

  return (
    <div>
      {alert && (
        <div className={`alert alert--${alert.type}`}>
          {alert.text}
        </div>
      )}

      <div className="card">
        <p className="card__title">Drop Documents</p>
        <DropZone onFilesAdded={handleFilesAdded} />
      </div>

      {files.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p className="card__title" style={{ marginBottom: 0 }}>Queue ({files.length})</p>
            <div style={{ display: 'flex', gap: 8 }}>
              {hasDone && (
                <button className="btn btn--secondary btn--sm" onClick={handleClearDone}>
                  Clear done
                </button>
              )}
              <button
                className="btn btn--primary"
                onClick={handleUploadAll}
                disabled={isUploading || pendingCount === 0}
              >
                {isUploading ? (
                  <><span className="spinner" /> Uploading…</>
                ) : (
                  `Upload ${pendingCount} file${pendingCount !== 1 ? 's' : ''}`
                )}
              </button>
            </div>
          </div>
          <FileList files={files} onRemove={handleRemove} />
        </div>
      )}

      <div className="card">
        <p className="card__title">How it works</p>
        <ol style={{ paddingLeft: 20, color: 'var(--text-muted)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <li>Drop your DOCX, PPTX, XLSX, or PDF documents above.</li>
          <li>Click <strong>Upload</strong> — files go to <code>docs-incoming/</code> in your GitHub repo.</li>
          <li>GitHub Actions automatically translates them and stores results in <code>translations/</code>.</li>
          <li>Switch to <strong>Translations</strong> to download the results when they are ready.</li>
        </ol>
      </div>
    </div>
  );
}
