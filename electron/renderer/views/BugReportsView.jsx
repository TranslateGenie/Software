import React, { useEffect, useState } from 'react';

const PAGE_SIZE = 10;

export default function BugReportsView({ onStatus }) {
  const [reports, setReports] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedReport, setSelectedReport] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ title: '', description: '', createdBy: '' });
  const [commentText, setCommentText] = useState('');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [statusDraft, setStatusDraft] = useState('open');
  const [editDraft, setEditDraft] = useState({ title: '', description: '' });

  const loadAdminState = async () => {
    try {
      const state = await window.mdas.isAdminUnlocked();
      setAdminUnlocked(Boolean(state?.unlocked));
    } catch {
      setAdminUnlocked(false);
    }
  };

  const loadReports = async (nextPage = page) => {
    setLoading(true);
    try {
      const result = await window.mdas.listBugReports({ page: nextPage, pageSize: PAGE_SIZE });
      setReports(result?.items || []);
      setPage(result?.page || 1);
      setTotalPages(result?.totalPages || 1);
      setTotal(result?.total || 0);
      onStatus('Bug reports loaded', 'ok');
    } catch (err) {
      onStatus(err.message || 'Could not load bug reports', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAdminState();
    loadReports(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openReport = async (id) => {
    try {
      const report = await window.mdas.getBugReport(id);
      setSelectedReport(report);
      setStatusDraft(report?.status || 'open');
      setEditDraft({
        title: report?.title || '',
        description: report?.description || '',
      });
      onStatus('Bug report opened', 'ok');
    } catch (err) {
      onStatus(err.message || 'Could not open report', 'error');
    }
  };

  const createReport = async (event) => {
    event.preventDefault();
    if (!createForm.title.trim() || !createForm.description.trim()) {
      onStatus('Title and description are required', 'error');
      return;
    }

    try {
      await window.mdas.createBugReport({
        title: createForm.title.trim(),
        description: createForm.description.trim(),
        createdBy: createForm.createdBy.trim() || 'anonymous',
      });
      setShowCreate(false);
      setCreateForm({ title: '', description: '', createdBy: '' });
      await loadReports(1);
      onStatus('Bug report created', 'ok');
    } catch (err) {
      onStatus(err.message || 'Could not create bug report', 'error');
    }
  };

  const loginAdmin = async () => {
    try {
      const result = await window.mdas.adminLogin(adminPassword);
      if (!result?.ok) {
        onStatus(result?.error || 'Invalid admin password', 'error');
        return;
      }
      setAdminPassword('');
      setAdminUnlocked(true);
      onStatus('Admin mode unlocked', 'ok');
    } catch (err) {
      onStatus(err.message || 'Could not unlock admin mode', 'error');
    }
  };

  const logoutAdmin = async () => {
    await window.mdas.adminLogout();
    setAdminUnlocked(false);
    onStatus('Admin mode locked', 'ok');
  };

  const submitComment = async () => {
    if (!selectedReport) return;
    if (!commentText.trim()) return;

    try {
      const updated = await window.mdas.addBugReportComment({
        id: selectedReport.id,
        message: commentText.trim(),
      });
      setSelectedReport(updated);
      setCommentText('');
      await loadReports(page);
      onStatus('Comment added', 'ok');
    } catch (err) {
      onStatus(err.message || 'Could not add comment', 'error');
    }
  };

  const updateStatus = async () => {
    if (!selectedReport) return;

    try {
      const updated = await window.mdas.updateBugReportStatus({
        id: selectedReport.id,
        status: statusDraft,
      });
      setSelectedReport(updated);
      await loadReports(page);
      onStatus('Status updated', 'ok');
    } catch (err) {
      onStatus(err.message || 'Could not update status', 'error');
    }
  };

  const updateDetails = async () => {
    if (!selectedReport) return;
    if (!editDraft.title.trim() || !editDraft.description.trim()) {
      onStatus('Title and description are required', 'error');
      return;
    }

    try {
      const updated = await window.mdas.updateBugReportDetails({
        id: selectedReport.id,
        title: editDraft.title.trim(),
        description: editDraft.description.trim(),
      });
      setSelectedReport(updated);
      await loadReports(page);
      onStatus('Report updated', 'ok');
    } catch (err) {
      onStatus(err.message || 'Could not update report', 'error');
    }
  };

  return (
    <div>
      <div className="card">
        <div className="toolbar-row">
          <p className="card__title" style={{ marginBottom: 0 }}>Bug Reports ({total})</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--secondary btn--sm" onClick={() => loadReports(page)} disabled={loading}>
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
              Add New Report
            </button>
          </div>
        </div>

        <div className="admin-row">
          {!adminUnlocked && (
            <>
              <input
                className="input-inline"
                type="password"
                placeholder="Admin password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
              <button className="btn btn--secondary btn--sm" onClick={loginAdmin}>Admin Login</button>
            </>
          )}
          {adminUnlocked && (
            <>
              <span className="badge badge--ok">Admin Mode Enabled</span>
              <button className="btn btn--secondary btn--sm" onClick={logoutAdmin}>Logout</button>
            </>
          )}
        </div>

        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Created</th>
                <th>Comments</th>
              </tr>
            </thead>
            <tbody>
              {reports.length === 0 && (
                <tr>
                  <td colSpan={4} className="table-empty">No bug reports yet.</td>
                </tr>
              )}
              {reports.map((report) => (
                <tr key={report.id} onClick={() => openReport(report.id)}>
                  <td>{report.title}</td>
                  <td><span className={`badge badge--${report.status.replace(/\s+/g, '-')}`}>{report.status}</span></td>
                  <td>{new Date(report.createdAt).toLocaleString()}</td>
                  <td>{report.commentCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button className="btn btn--secondary btn--sm" disabled={page <= 1} onClick={() => loadReports(page - 1)}>
            Previous
          </button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn btn--secondary btn--sm" disabled={page >= totalPages} onClick={() => loadReports(page + 1)}>
            Next
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <p className="card__title">Add New Bug Report</p>
            <form className="settings-form" onSubmit={createReport}>
              <div className="form-field">
                <label>Title</label>
                <input
                  value={createForm.title}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, title: e.target.value }))}
                  placeholder="Crash when uploading PDF"
                />
              </div>
              <div className="form-field">
                <label>Description</label>
                <textarea
                  rows={5}
                  className="textarea"
                  value={createForm.description}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="App freezes when uploading a 20MB PDF..."
                />
              </div>
              <div className="form-field">
                <label>Email (optional)</label>
                <input
                  value={createForm.createdBy}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, createdBy: e.target.value }))}
                  placeholder="user@example.com"
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn--primary" type="submit">Submit Report</button>
                <button className="btn btn--secondary" type="button" onClick={() => setShowCreate(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedReport && (
        <div className="modal-backdrop" onClick={() => setSelectedReport(null)}>
          <div className="modal-card modal-card--lg" onClick={(event) => event.stopPropagation()}>
            <div className="toolbar-row" style={{ marginBottom: 12 }}>
              <p className="card__title" style={{ marginBottom: 0 }}>{selectedReport.title}</p>
              <button className="btn btn--secondary btn--sm" onClick={() => setSelectedReport(null)}>Close</button>
            </div>
            <p style={{ marginBottom: 10 }}>{selectedReport.description}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 14 }}>
              #{selectedReport.id} by {selectedReport.createdBy} on {new Date(selectedReport.createdAt).toLocaleString()}
            </p>

            <div className="comments-box">
              {selectedReport.comments.length === 0 && <p className="table-empty">No comments yet.</p>}
              {selectedReport.comments.map((comment, idx) => (
                <div key={`${comment.timestamp}-${idx}`} className="comment-item">
                  <div className="comment-head">
                    <strong>{comment.author}</strong>
                    <span>{new Date(comment.timestamp).toLocaleString()}</span>
                  </div>
                  <p>{comment.message}</p>
                </div>
              ))}
            </div>

            {adminUnlocked && (
              <div className="admin-panel">
                <div className="form-field">
                  <label>Edit Report</label>
                  <input
                    value={editDraft.title}
                    onChange={(e) => setEditDraft((prev) => ({ ...prev, title: e.target.value }))}
                  />
                  <textarea
                    rows={4}
                    className="textarea"
                    value={editDraft.description}
                    onChange={(e) => setEditDraft((prev) => ({ ...prev, description: e.target.value }))}
                  />
                  <button className="btn btn--secondary btn--sm" onClick={updateDetails}>Save Details</button>
                </div>

                <div className="form-field">
                  <label>Change Status</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select value={statusDraft} onChange={(e) => setStatusDraft(e.target.value)}>
                      <option value="open">open</option>
                      <option value="in progress">in progress</option>
                      <option value="resolved">resolved</option>
                    </select>
                    <button className="btn btn--secondary btn--sm" onClick={updateStatus}>Save</button>
                  </div>
                </div>

                <div className="form-field">
                  <label>Add Comment</label>
                  <textarea
                    rows={3}
                    className="textarea"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Thanks for reporting this. We are investigating..."
                  />
                  <button className="btn btn--primary btn--sm" onClick={submitComment}>Post Comment</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
