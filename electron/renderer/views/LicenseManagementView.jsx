import React, { useMemo, useState } from 'react';

function formatDate(ts) {
  if (!ts) return 'Not set';
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return 'Not set';
  return date.toLocaleString();
}

export default function LicenseManagementView({ onStatus, licenseSession, onLicenseSessionUpdated }) {
  const [loading, setLoading] = useState(false);

  const metrics = useMemo(() => {
    const limit = Number(licenseSession?.limit || 0);
    const requests = Number(licenseSession?.requests || 0);
    const charLimit = Number(licenseSession?.charLimit || 0);
    const characters = Number(licenseSession?.characters || 0);
    return {
      remainingRequests: Math.max(0, limit - requests),
      remainingCharacters: Math.max(0, charLimit - characters),
      requestText: `${requests} / ${limit}`,
      characterText: `${characters} / ${charLimit}`,
    };
  }, [licenseSession]);

  const refreshLicense = async () => {
    setLoading(true);
    onStatus('Refreshing license...', 'warn');
    try {
      const refreshed = await window.mdas.refreshLicenseSession();
      if (onLicenseSessionUpdated) {
        onLicenseSessionUpdated(refreshed);
      }
      if (refreshed?.valid) {
        onStatus('License refreshed successfully', 'ok');
      } else {
        onStatus('License is missing or invalid', 'error');
      }
    } catch (err) {
      onStatus(err.message || 'Failed to refresh license', 'error');
    } finally {
      setLoading(false);
    }
  };

  const openPricingPage = async () => {
    try {
      await window.mdas.openPricingPage();
      onStatus('Opened pricing page in your browser', 'ok');
    } catch (err) {
      onStatus(err.message || 'Could not open pricing page', 'error');
    }
  };

  return (
    <div>
      <div className="card">
        <p className="card__title">License Change or Renewal</p>
        <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
          Review your current plan usage, then open pricing to change or renew your license.
          After purchase, click refresh to re-validate and pull updated limits.
        </p>
        <div className="metrics-grid">
          <div className="metric-card">
            <span className="metric-label">Current Tier</span>
            <span className="metric-value">{licenseSession?.type || 'Unknown'}</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Remaining Requests</span>
            <span className="metric-value">{metrics.remainingRequests}</span>
            <span className="metric-sub">Used: {metrics.requestText}</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Remaining Characters</span>
            <span className="metric-value">{metrics.remainingCharacters.toLocaleString()}</span>
            <span className="metric-sub">Used: {metrics.characterText}</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Expiration Date</span>
            <span className="metric-value metric-value--sm">{formatDate(licenseSession?.expiresAt)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button className="btn btn--primary" onClick={openPricingPage}>
            Change / Renew License
          </button>
          <button className="btn btn--secondary" onClick={refreshLicense} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh License'}
          </button>
        </div>
      </div>
    </div>
  );
}
