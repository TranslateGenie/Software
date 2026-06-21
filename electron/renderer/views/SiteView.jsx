import React, { useEffect, useState } from 'react';

const TAG_COLORS = {
  Feature: 'var(--accent)',
  Fix: 'var(--success)',
  Improvement: 'var(--warning)',
  Security: 'var(--error)',
};

function formatDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

export default function SiteView() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('https://translate-genie-json.s3.us-east-2.amazonaws.com/news.json')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => {
        const sorted = [...data].sort((a, b) => new Date(b.date) - new Date(a.date));
        setItems(sorted);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="card" style={{ marginBottom: 20 }}>
        <p className="card__title">Product Updates</p>
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          Release notes, feature announcements, and improvements — newest first.
        </p>
      </div>

      {loading && (
        <div className="card">
          <p style={{ color: 'var(--text-muted)' }}>Loading updates…</p>
        </div>
      )}

      {error && (
        <div className="card">
          <p style={{ color: 'var(--error)' }}>Could not load updates — {error}</p>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="card">
          <p style={{ color: 'var(--text-muted)' }}>No updates yet.</p>
        </div>
      )}

      {items.map((item) => (
        <div className="card" key={`${item.version}-${item.date}`} style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
              padding: '2px 8px', borderRadius: 4,
              background: `${TAG_COLORS[item.tag] ?? 'var(--text-muted)'}22`,
              color: TAG_COLORS[item.tag] ?? 'var(--text-muted)',
            }}>
              {item.tag}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{item.version}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>{formatDate(item.date)}</span>
          </div>
          <p style={{ fontWeight: 600, marginBottom: 6 }}>{item.title}</p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>{item.body}</p>
        </div>
      ))}
    </div>
  );
}
