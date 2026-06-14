/**
 * dev-storage.js — Local filesystem mock of s3-data.js for MDAS_ENV=dev.
 * Mirrors every exported function signature so storage.js can swap implementations
 * transparently. No AWS credentials or network calls required.
 *
 * Translation files are handled separately by user-storage.js on all envs.
 */

import path from 'path';
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

const devStorageDir = process.env.MDAS_DEV_STORAGE_DIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev-storage');

// ── Licenses ──────────────────────────────────────────────────────────────────

export async function loadLicenses() {
  return {
    json: [
      {
        key: 'DEV-0000-0000-0000',
        org: 'dev-org',
        type: 'T2',
        valid: true,
        requests: 0,
        limit: 99999,
        characters: 0,
        charLimit: 999999999,
      },
    ],
    etag: 'dev',
    signature: { verified: false, reason: 'dev-mode' },
    signedAt: null,
  };
}

export async function saveLicenses() {
  // no-op: usage counters don't persist between dev restarts
}

// ── Static Content ────────────────────────────────────────────────────────────

export async function loadNews() {
  const raw = await readFile(path.join(devStorageDir, 'news.json'), 'utf8');
  return JSON.parse(raw);
}

export async function loadReviews() {
  const raw = await readFile(path.join(devStorageDir, 'reviews.json'), 'utf8');
  return JSON.parse(raw);
}

// ── Bug Reports ───────────────────────────────────────────────────────────────

const bugReportsPath = path.join(devStorageDir, 'bug-reports.json');

async function readBugReports() {
  if (!existsSync(bugReportsPath)) return [];
  const raw = await readFile(bugReportsPath, 'utf8');
  return JSON.parse(raw);
}

export async function listBugReports() {
  return readBugReports();
}

export async function getBugReportById(id) {
  const reports = await readBugReports();
  const report = reports.find((r) => r.id === id);
  if (!report) throw new Error(`Bug report ${id} not found.`);
  return report;
}

export async function saveBugReport(report) {
  const reports = await readBugReports();
  const index = reports.findIndex((r) => r.id === report.id);
  if (index === -1) {
    reports.push(report);
  } else {
    reports[index] = report;
  }
  await writeFile(bugReportsPath, JSON.stringify(reports, null, 2));
}
