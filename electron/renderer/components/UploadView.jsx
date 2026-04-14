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

export default function UploadView({ onStatus, licenseSession, onLicenseSessionUpdated }) {
  const [files, setFiles] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [alert, setAlert] = useState(null);

  const limit = Number(licenseSession?.limit ?? 0);
  const requests = Number(licenseSession?.requests ?? 0);
  const charLimit = Number(licenseSession?.charLimit ?? 0);
  const characters = Number(licenseSession?.characters ?? 0);
  const remainingRequests = Math.max(0, limit - requests);
  const remainingCharacters = Math.max(0, charLimit - characters);
  const quotaReached = remainingRequests <= 0 || remainingCharacters <= 0;

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
    let effectiveSession = licenseSession;
    try {
      const refreshed = await window.mdas.refreshLicenseSession();
      if (onLicenseSessionUpdated) {
        onLicenseSessionUpdated(refreshed);
      }
      effectiveSession = refreshed;
    } catch {
      // Ignore refresh errors here; existing session values are used as fallback.
    }

    if (!effectiveSession?.valid) {
      setAlert({
        type: 'error',
        text: 'License is missing or invalid. Activate or renew your license before uploading.',
      });
      onStatus('Upload blocked: invalid license', 'error');
      return;
    }

    const refreshedLimit = Number(effectiveSession?.limit ?? 0);
    const refreshedRequests = Number(effectiveSession?.requests ?? 0);
    const refreshedCharLimit = Number(effectiveSession?.charLimit ?? 0);
    const refreshedCharacters = Number(effectiveSession?.characters ?? 0);
    const refreshedRemainingRequests = Math.max(0, refreshedLimit - refreshedRequests);
    const refreshedRemainingCharacters = Math.max(0, refreshedCharLimit - refreshedCharacters);
    const refreshedQuotaReached = refreshedRemainingRequests <= 0 || refreshedRemainingCharacters <= 0;

    if (refreshedQuotaReached || quotaReached) {
      setAlert({
        type: 'error',
        text: 'Your translation quota has been reached. Please purchase additional request packs.',
      });
      onStatus('Upload blocked: quota reached', 'error');
      return;
    }

    if ((refreshedLimit > 0 && refreshedRemainingRequests / refreshedLimit < 0.1) || (refreshedCharLimit > 0 && refreshedRemainingCharacters / refreshedCharLimit < 0.1)) {
      setAlert({
        type: 'warn',
        text: 'Your license is nearing its limits. Renew soon to avoid interruptions.',
      });
      onStatus('License nearing limits', 'warn');
    }

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
        <p className="card__title">First Translation Checklist</p>
        <ol style={{ paddingLeft: 20, color: 'var(--text-muted)', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <li>Confirm your license is active and quotas are available.</li>
          <li>Drop a document below and click <strong>Upload</strong>.</li>
          <li>Wait for workflow processing to complete in the background.</li>
          <li>Go to <strong>Translations</strong> and download your translated result.</li>
        </ol>
      </div>

      <div className="card">
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Remaining Requests: <strong>{remainingRequests}</strong> | Remaining Characters: <strong>{remainingCharacters}</strong>
        </p>
        {quotaReached && (
          <div className="alert alert--error" style={{ marginBottom: 12 }}>
            Your translation quota has been reached. Please purchase additional request packs.
          </div>
        )}
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
                disabled={isUploading || pendingCount === 0 || quotaReached}
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
          <li>Click <strong>Upload</strong> — files are sent securely to the managed translation backend.</li>
          <li>GitHub Actions automatically translates them and stores results in <code>translations/</code>.</li>
          <li>Switch to <strong>Translations</strong> to download the results when they are ready.</li>
        </ol>
      </div>
    </div>
  );
}
