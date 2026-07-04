/**
 * exporter.js
 * 
 * Handles generating organized directories and assets for manual application.
 * Compiles a detailed text info card, a tailored PDF resume, a cover letter, 
 * a cold email, and a LinkedIn connection note inside joblistings/[Index]_[Company]_[Role]/.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createPDFBuffer } = require('./notifier');

/**
 * Sanitizes a string for use as a folder name (Windows/macOS compatible).
 */
function sanitizeName(name) {
  if (!name) return 'Unknown';
  return name
    .replace(/[\\/:*?"<>|]/g, '') // remove illegal characters
    .replace(/\s+/g, '_')         // replace spaces with underscores
    .trim();
}

/**
 * Counts existing folders inside joblistings to get the next sequential number.
 */
function getNextFolderNumber(baseDir) {
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
    return '01';
  }
  try {
    const files = fs.readdirSync(baseDir);
    const folders = files.filter(f => {
      try {
        return fs.statSync(path.join(baseDir, f)).isDirectory();
      } catch (_) {
        return false;
      }
    });
    
    // Scan for highest prefix number to prevent collision
    let maxNum = 0;
    for (const folder of folders) {
      const match = folder.match(/^(\d+)_/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
    
    const nextNum = maxNum > 0 ? maxNum + 1 : folders.length + 1;
    return String(nextNum).padStart(2, '0');
  } catch (err) {
    console.error('[Exporter] Error scanning joblistings directory:', err);
    return '01';
  }
}

/**
 * Generates and saves all tailored assets for a job.
 * 
 * @param {object} job - Job object
 * @param {object} config - Configuration object
 * @param {function} logFn - Optional logger
 * @returns {Promise<{success: boolean, folderPath: string, relativePath: string}>}
 */
async function exportJobAssets(job, config, logFn = console.log) {
  const baseDir = path.join(__dirname, '..', 'joblistings');

  // Date-based subfolder: joblistings/2026-07-04/
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const dayDir = path.join(baseDir, today);

  const nextNum = getNextFolderNumber(dayDir);

  const sanitizedCompany = sanitizeName(job.company || 'Unknown_Company');
  const sanitizedTitle = sanitizeName(job.title || 'Unknown_Role');
  const folderName = `${nextNum}_${sanitizedCompany}_${sanitizedTitle}`;
  const jobFolder = path.join(dayDir, folderName);
  const relativePath = path.join('joblistings', today, folderName);


  logFn(`Generating job application assets in folder: ${relativePath}`, 'info');

  try {
    // 1. Create target folder
    if (!fs.existsSync(jobFolder)) {
      fs.mkdirSync(jobFolder, { recursive: true });
    }

    // 2. Create STATUS.txt — rename to [APPLIED] when done
    const statusPath = path.join(jobFolder, '📋 STATUS.txt');
    const statusContent = `========================================================================
APPLICATION STATUS TRACKER
========================================================================
Status:    [ PENDING ] ← Change to [APPLIED ✅] when done
Applied:   ___ / ___ / ______   (fill in date)
Platform:  _________________________  (e.g. LinkedIn, Company Website)
Notes:     _________________________

Company:   ${job.company || 'Unknown'}
Role:      ${job.title || 'Unknown'}
Score:     ${job.score || 'N/A'}/10
Confidence:${job.confidence || 'N/A'}%
Apply URL: ${job.url || 'No URL'}
Recruiter: ${job.poster?.name || 'N/A'} (${job.poster?.url || 'No URL'})
========================================================================
TIP: To mark this as applied, just rename this file to:
     ✅ APPLIED - [date].txt
========================================================================
`;
    fs.writeFileSync(statusPath, statusContent, 'utf8');
    logFn('  → Saved 📋 STATUS.txt', 'info');

    // 3. Create Apply_Link_&_Details.txt
    const detailsPath = path.join(jobFolder, 'Apply_Link_&_Details.txt');
    const detailsContent = `========================================================================
JOB APPLICATION DETAILS
========================================================================
Company:          ${job.company || 'Unknown'}
Job Title:        ${job.title || 'Unknown'}
Match Score:      ${job.score || 'N/A'}/10
Confidence Score: ${job.confidence || 'N/A'}%
Export Date:      ${new Date().toLocaleString()}

------------------------------------------------------------------------
HOW TO APPLY:
👉 Click/Copy this Link: ${job.url || 'No URL available'}
------------------------------------------------------------------------

Basic Details & Scraped Information:
- Location:      ${job.location || 'N/A'}
- Salary/Budget: ${job.salary || 'N/A'}
- Source:        ${job.source || 'Scraped Link'}
- Recruiter:     ${job.poster?.name || 'N/A'} (${job.poster?.url || 'No URL'})

Job Description Summary:
${(job.description || '').substring(0, 1000)}${(job.description || '').length > 1000 ? '...' : ''}
`;
    fs.writeFileSync(detailsPath, detailsContent, 'utf8');
    logFn('  → Saved Apply_Link_&_Details.txt', 'info');

    // 3. Create Tailored_Resume.pdf
    const resumeText = job.tailoredResume || config.masterResume || '';
    if (resumeText) {
      try {
        const resumeBuffer = await createPDFBuffer(resumeText, 'resume');
        if (resumeBuffer) {
          const resumePath = path.join(jobFolder, 'Tailored_Resume.pdf');
          fs.writeFileSync(resumePath, resumeBuffer);
          logFn('  → Compiled and saved Tailored_Resume.pdf', 'info');
        } else {
          logFn('  [Warning] PDF generation returned empty buffer, writing text fallback.', 'warning');
          fs.writeFileSync(path.join(jobFolder, 'Tailored_Resume_Fallback.txt'), resumeText, 'utf8');
        }
      } catch (pdfErr) {
        logFn(`  [Warning] Failed to compile PDF: ${pdfErr.message}. Saving text fallback.`, 'warning');
        fs.writeFileSync(path.join(jobFolder, 'Tailored_Resume_Fallback.txt'), resumeText, 'utf8');
      }
    } else {
      logFn('  [Warning] No tailored or master resume text available to generate PDF.', 'warning');
    }

    // 4. Create Cover_Letter.txt
    const coverText = job.coverLetter || '';
    if (coverText) {
      const coverPath = path.join(jobFolder, 'Cover_Letter.txt');
      fs.writeFileSync(coverPath, coverText, 'utf8');
      logFn('  → Saved Cover_Letter.txt', 'info');
    }

    // 5. Create Cold_Email.txt
    const emailText = job.coldEmail || '';
    if (emailText) {
      const emailPath = path.join(jobFolder, 'Cold_Email.txt');
      fs.writeFileSync(emailPath, emailText, 'utf8');
      logFn('  → Saved Cold_Email.txt', 'info');
    }

    // 6. Create LinkedIn_Note.txt (Always create if poster details OR note exist)
    const linkedinNote = job.linkedinNote || '';
    const hasPoster = job.poster && (job.poster.name || job.poster.url);
    if (linkedinNote || hasPoster) {
      const notePath = path.join(jobFolder, 'LinkedIn_Note.txt');
      const noteContent = `========================================================================
LINKEDIN RECRUITER OUTREACH & NOTE DETAILS
========================================================================
Recruiter Name:   ${job.poster?.name || 'Unknown'}
Recruiter Title:  ${job.poster?.title || 'Unknown'}
Profile URL:      ${job.poster?.url || 'No URL available'}
========================================================================

Tailored Connection Message (Copy & paste - Max 300 Chars):
------------------------------------------------------------------------
${linkedinNote}
------------------------------------------------------------------------
`;
      fs.writeFileSync(notePath, noteContent, 'utf8');
      logFn('  → Saved LinkedIn_Note.txt', 'info');
    }

    logFn(`Successfully compiled all assets for "${job.title}" at ${job.company}!`, 'success');
    return {
      success: true,
      folderPath: jobFolder,
      relativePath: relativePath.replace(/\\/g, '/') // standard forward slashes for URLs/UI
    };
  } catch (err) {
    logFn(`Error exporting assets: ${err.message}`, 'error');
    return {
      success: false,
      error: err.message
    };
  }
}

module.exports = {
  exportJobAssets,
  sanitizeName
};
