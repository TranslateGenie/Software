/**
 * storage.js — Environment-aware storage abstraction.
 * Routes all calls to the local filesystem (dev) or AWS S3 (prod)
 * based on the MDAS_ENV environment variable.
 *
 * Import from here instead of s3-data.js so the same API code works in both modes.
 */

const IS_DEV = process.env.MDAS_ENV === 'dev';

const impl = IS_DEV
  ? await import('./dev-storage.js')
  : await import('./s3-data.js');

export const loadLicenses       = impl.loadLicenses;
export const saveLicenses       = impl.saveLicenses;
export const listBugReports     = impl.listBugReports;
export const getBugReportById   = impl.getBugReportById;
export const saveBugReport      = impl.saveBugReport;
export const loadNews           = impl.loadNews;
export const loadReviews        = impl.loadReviews;
