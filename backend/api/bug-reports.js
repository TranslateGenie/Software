import { randomUUID } from 'crypto';
import { listBugReports, getBugReportById, saveBugReport } from '../lib/storage.js';

function normalizeBugReport(report) {
  return {
    id: String(report?.id || randomUUID()),
    title: String(report?.title || 'Untitled report'),
    description: String(report?.description || ''),
    createdBy: String(report?.createdBy || 'anonymous'),
    createdAt: String(report?.createdAt || new Date().toISOString()),
    status: String(report?.status || 'open'),
    comments: Array.isArray(report?.comments)
      ? report.comments.map((item) => ({
          author: String(item?.author || 'user'),
          message: String(item?.message || ''),
          timestamp: String(item?.timestamp || new Date().toISOString()),
        }))
      : [],
  };
}

function nextBugReportId(existingIds) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const datePrefix = `${year}-${month}-${day}`;

  const used = new Set(
    existingIds
      .map((id) => String(id || ''))
      .filter((id) => id.startsWith(`${datePrefix}-`))
      .map((id) => Number(id.slice(-3)))
      .filter((value) => Number.isFinite(value))
  );

  let seq = 1;
  while (used.has(seq)) seq += 1;
  return `${datePrefix}-${String(seq).padStart(3, '0')}`;
}

function assertAdmin(req) {
  if (String(req.headers['x-admin-unlocked'] || '').toLowerCase() !== 'true') {
    throw new Error('Admin mode is required for this action.');
  }
}

export async function listBugReportsHandler(req, res) {
  try {
    const { page = 1, pageSize = 10 } = req.query || {};
    const reports = (await listBugReports()).map((item) => normalizeBugReport(item));

    const total = reports.length;
    const safePageSize = Math.max(1, Number(pageSize) || 10);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const start = (safePage - 1) * safePageSize;

    const items = reports.slice(start, start + safePageSize).map((report) => ({
      id: report.id,
      title: report.title,
      createdAt: report.createdAt,
      status: report.status,
      createdBy: report.createdBy,
      commentCount: report.comments.length,
    }));

    return res.status(200).json({
      ok: true,
      items,
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to list bug reports.' });
  }
}

export async function getBugReportHandler(req, res) {
  try {
    const id = String(req.params.id || '');
    const report = normalizeBugReport(await getBugReportById(id));
    return res.status(200).json({ ok: true, item: report });
  } catch (error) {
    return res.status(404).json({ ok: false, error: error.message || 'Bug report not found.' });
  }
}

export async function createBugReportHandler(req, res) {
  try {
    const all = (await listBugReports()).map((item) => normalizeBugReport(item));
    const id = nextBugReportId(all.map((item) => item.id));

    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const createdBy = String(req.body?.createdBy || 'anonymous').trim() || 'anonymous';

    if (!title || !description) {
      return res.status(400).json({ ok: false, error: 'Title and description are required.' });
    }

    const report = normalizeBugReport({
      id,
      title,
      description,
      createdBy,
      createdAt: new Date().toISOString(),
      status: 'open',
      comments: [],
    });

    await saveBugReport(report);
    return res.status(201).json({ ok: true, item: report });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to create bug report.' });
  }
}

export async function addBugReportCommentHandler(req, res) {
  try {
    assertAdmin(req);

    const id = String(req.params.id || '');
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ ok: false, error: 'Comment message is required.' });
    }

    const report = normalizeBugReport(await getBugReportById(id));
    report.comments.push({
      author: 'admin',
      message,
      timestamp: new Date().toISOString(),
    });

    await saveBugReport(report);
    return res.status(200).json({ ok: true, item: report });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to add bug report comment.' });
  }
}

export async function updateBugReportStatusHandler(req, res) {
  try {
    assertAdmin(req);

    const allowedStatuses = new Set(['open', 'in progress', 'resolved']);
    const nextStatus = String(req.body?.status || '').toLowerCase();
    if (!allowedStatuses.has(nextStatus)) {
      return res.status(400).json({ ok: false, error: 'Status must be one of: open, in progress, resolved.' });
    }

    const id = String(req.params.id || '');
    const report = normalizeBugReport(await getBugReportById(id));
    report.status = nextStatus;
    await saveBugReport(report);

    return res.status(200).json({ ok: true, item: report });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to update bug report status.' });
  }
}

export async function updateBugReportDetailsHandler(req, res) {
  try {
    assertAdmin(req);

    const id = String(req.params.id || '');
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!title || !description) {
      return res.status(400).json({ ok: false, error: 'Title and description are required.' });
    }

    const report = normalizeBugReport(await getBugReportById(id));
    report.title = title;
    report.description = description;
    await saveBugReport(report);

    return res.status(200).json({ ok: true, item: report });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Failed to update bug report details.' });
  }
}
