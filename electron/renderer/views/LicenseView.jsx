import React, { useState } from 'react';

export default function LicenseView({ onValidated, onStatus }) {
  const [licenseKey, setLicenseKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (!licenseKey.trim()) {
      setError('Enter your license key to continue.');
      return;
    }

    setLoading(true);
    setError('');
    onStatus('Validating license key...', 'warn');

    try {
      const result = await window.mdas.validateLicenseKey(licenseKey.trim());
      if (!result?.valid) {
        if (result?.reason === 'limit-reached') {
          setError('Your translation quota has been reached. Please purchase additional request packs.');
        } else {
          setError('License key is invalid or inactive.');
        }
        onStatus('License validation failed', 'error');
        return;
      }

      onValidated({
        token: result.token,
        org: result.org,
        type: result.type,
        limit: result.limit,
        requests: result.requests,
        charLimit: result.charLimit,
        characters: result.characters,
      });
      onStatus('License activated', 'ok');
    } catch (err) {
      setError(err.message || 'Could not validate license key.');
      onStatus('License validation error', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 540, margin: '6vh auto' }}>
      <p className="card__title">Enter License Key</p>
      <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
        This build is linked to managed backend infrastructure. Enter your license key to unlock upload and translation.
      </p>

      <form onSubmit={submit} className="settings-form" style={{ maxWidth: '100%' }}>
        <div className="form-field">
          <label htmlFor="licenseKey">License Key</label>
          <input
            id="licenseKey"
            type="password"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder="TGSA-XXXX-XXXX-XXXX"
            autoComplete="off"
          />
        </div>

        {error && <div className="alert alert--error">{error}</div>}

        <button className="btn btn--primary" type="submit" disabled={loading}>
          {loading ? 'Validating...' : 'Activate License'}
        </button>
      </form>
    </div>
  );
}
