// ============================================================
// Job Hunter — Google Apps Script (Updated with Delete & Batch Support)
// ============================================================
// HOW TO DEPLOY:
//  1. Open your Google Sheet → Extensions → Apps Script
//  2. Replace ALL code with this file's contents
//  3. Click Deploy → Manage Deployments → Edit (pencil icon)
//  4. Set "Who has access" to "Anyone"
//  5. Click Deploy → copy the new Web App URL
//  6. Paste the URL into your dashboard Profile Setup → Google Sheets URL
// ============================================================

const SHEET_NAME = 'Jobs';

const HEADERS = [
  'ID', 'Title', 'Company', 'Location', 'URL',
  'Score', 'Score Reason', 'Status', 'Timestamp',
  'Recruiter Name', 'Recruiter Title', 'Recruiter Profile',
  'Cold Email'
];

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    // Style the header row
    const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
    headerRange.setBackground('#1e293b');
    headerRange.setFontColor('#a5b4fc');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findRowById(sheet, id) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      return i + 1; // 1-indexed sheet row
    }
  }
  return -1;
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const sheet = getOrCreateSheet();

    // ── BATCH action ─────────────────────────────────────
    if (payload.action === 'batch') {
      const items = payload.items || [];
      let successCount = 0;
      let failCount = 0;
      
      for (const item of items) {
        try {
          const res = processSingleItem(sheet, item);
          if (res.success) {
            successCount++;
          } else {
            failCount++;
          }
        } catch (itemErr) {
          failCount++;
        }
      }
      return jsonResponse({ success: true, message: `Processed batch of ${items.length} items. Success: ${successCount}, Failed: ${failCount}` });
    }

    // ── SINGLE ITEM processing ────────────────────────────
    const result = processSingleItem(sheet, payload);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function processSingleItem(sheet, payload) {
  // ── DELETE action ─────────────────────────────────────
  if (payload.action === 'delete') {
    if (!payload.id) {
      return { success: false, error: 'Missing id for delete action.' };
    }
    const rowNum = findRowById(sheet, payload.id);
    if (rowNum === -1) {
      return { success: true, message: 'Row not found in sheet (already clean).' };
    }
    sheet.deleteRow(rowNum);
    return { success: true, message: `Row ${rowNum} deleted for job ${payload.id}.` };
  }

  // ── UPSERT action (default: add or update row) ────────
  const {
    id, title, company, location, url,
    score, scoreReason, status, timestamp,
    posterName, posterTitle, posterUrl, coldEmail
  } = payload;

  if (!id) {
    return { success: false, error: 'Missing id.' };
  }

  const rowData = [
    id, title || '', company || '', location || '', url || '',
    score || '', scoreReason || '', status || '', timestamp || new Date().toISOString(),
    posterName || '', posterTitle || '', posterUrl || '',
    coldEmail || ''
  ];

  const existingRow = findRowById(sheet, id);

  if (existingRow !== -1) {
    // Update existing row
    sheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
  } else {
    // Append new row
    sheet.appendRow(rowData);
  }

  // Colour-code status column (col 8)
  const newRow = existingRow !== -1 ? existingRow : sheet.getLastRow();
  const statusCell = sheet.getRange(newRow, 8);
  const statusColors = {
    submitted: { bg: '#14532d', fg: '#4ade80' },
    ready:     { bg: '#1e3a5f', fg: '#60a5fa' },
    scored:    { bg: '#2d1b69', fg: '#a78bfa' },
    review:    { bg: '#451a03', fg: '#fb923c' },
    skipped:   { bg: '#1c1917', fg: '#78716c' },
    discovered:{ bg: '#0c0a09', fg: '#a8a29e' }
  };
  const colors = statusColors[status] || { bg: '#1e293b', fg: '#fff' };
  statusCell.setBackground(colors.bg);
  statusCell.setFontColor(colors.fg);

  return { success: true };
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Allow GET for connectivity testing
function doGet(e) {
  return jsonResponse({ status: 'ok', message: 'Job Hunter Apps Script is running.' });
}
