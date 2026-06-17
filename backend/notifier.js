const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

// Callback that server.js registers so we can save processed jobs to the database
let onJobProcessedCallback = null;

function registerOnJobProcessed(callback) {
  onJobProcessedCallback = callback;
}

/**
 * Helper to safely send a message with a timeout.
 */
function withTimeout(promise, ms, operationName) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${operationName} timed out (${ms / 1000}s)`)), ms))
  ]);
}

/**
 * Render markdown-formatted resume text into a properly styled PDF.
 */
function renderMarkdownToPdf(doc, markdownText) {
  const lines = markdownText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    if (rawLine.startsWith('# ')) {
      const text = rawLine.replace(/^# /, '').replace(/\*\*/g, '');
      if (i > 0) doc.moveDown(0.5);
      doc.fontSize(18).font('Helvetica-Bold').text(text, { align: 'center' });
      doc.moveDown(0.2);
      continue;
    }

    if (rawLine.startsWith('## ')) {
      const text = rawLine.replace(/^## /, '').replace(/\*\*/g, '').toUpperCase();
      doc.moveDown(0.6);
      doc.fontSize(12).font('Helvetica-Bold').text(text);
      const y = doc.y;
      doc.moveTo(50, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).stroke('#333333');
      doc.moveDown(0.3);
      continue;
    }

    if (rawLine.startsWith('### ')) {
      const text = rawLine.replace(/^### /, '').replace(/\*\*/g, '');
      doc.moveDown(0.3);
      doc.fontSize(11).font('Helvetica-Bold').text(text);
      continue;
    }

    if (rawLine.match(/^- /)) {
      const text = rawLine.replace(/^- /, '').replace(/\*\*/g, '');
      doc.fontSize(10).font('Helvetica').text(`  •  ${text}`, { indent: 10 });
      continue;
    }

    if (rawLine.trim() === '') {
      doc.moveDown(0.2);
      continue;
    }

    const parts = rawLine.split(/(\*\*[^*]+\*\*)/g);
    const hasBold = parts.some(p => p.startsWith('**'));
    if (hasBold) {
      for (const part of parts) {
        if (part.startsWith('**') && part.endsWith('**')) {
          const boldText = part.replace(/\*\*/g, '');
          doc.fontSize(10).font('Helvetica-Bold').text(boldText, { continued: parts.indexOf(part) < parts.length - 1 });
        } else if (part.length > 0) {
          doc.fontSize(10).font('Helvetica').text(part, { continued: parts.indexOf(part) < parts.length - 1 });
        }
      }
      doc.text('', { continued: false });
    } else {
      doc.fontSize(10).font('Helvetica').text(rawLine);
    }
  }
}

/**
 * Sends job details via Discord Webhook
 */
async function sendDiscordAlert(job, config, systemLog) {
  if (!config.discordWebhookUrl) return false;

  systemLog(`[Notifier] Sending job to Discord: ${job.title} at ${job.company}...`, 'info');

  const content = `**New Job Ready to Apply!** 🚀\n` +
    `**Title:** ${job.title}\n` +
    `**Company:** ${job.company}\n` +
    `**Location:** ${job.location || 'N/A'}\n` +
    `**Confidence:** ${job.confidenceScore || job.confidence || 'N/A'}%\n` +
    `**Apply Link:** ${job.url}\n\n` +
    (job.hrDetails?.hrEmail ? `**HR Email Found:** ${job.hrDetails.hrEmail}\n` : '') +
    (job.hrDetails?.careerSiteUrl ? `**Career Site:** <${job.hrDetails.careerSiteUrl}>\n` : '');

  const payload = { content: content };

  try {
    const response = await withTimeout(
      fetch(config.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }),
      10000,
      'Discord Webhook POST'
    );

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    systemLog(`[Notifier] Discord alert sent successfully for ${job.title}.`, 'success');
    return true;
  } catch (err) {
    systemLog(`[Notifier] Discord sending error: ${err.message}`, 'error');
    return false;
  }
}

/**
 * Sends job details and attachments via Email
 */
async function sendEmailAlert(job, config, systemLog, pdfPath) {
  if (!config.enableEmailAlerts || !config.smtpHost || !config.smtpUser || !config.smtpPass || !config.senderEmail) {
    return false;
  }

  systemLog(`[Notifier] Sending job email alert to ${config.senderEmail}...`, 'info');

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort || 587,
    secure: config.smtpSecure || false,
    auth: { user: config.smtpUser, pass: config.smtpPass }
  });

  const mailOptions = {
    from: `Job Auto-Applier <${config.senderEmail}>`,
    to: config.senderEmail,
    subject: `Job Alert: ${job.title} at ${job.company}`,
    text: `A new job is ready for your review.\n\n` +
          `Title: ${job.title}\n` +
          `Company: ${job.company}\n` +
          `Location: ${job.location || 'N/A'}\n` +
          `Confidence Score: ${job.confidenceScore || job.confidence || 'N/A'}%\n\n` +
          `Apply Link: ${job.url}\n\n` +
          (job.hrDetails?.hrEmail ? `HR Email: ${job.hrDetails.hrEmail}\n` : '') +
          (job.hrDetails?.careerSiteUrl ? `Career Site: ${job.hrDetails.careerSiteUrl}\n\n` : '') +
          (job.coverLetter ? `--- Cover Letter ---\n${job.coverLetter}\n\n` : '') +
          (job.coldEmail ? `--- Cold Email ---\n${job.coldEmail}\n\n` : ''),
    attachments: []
  };

  if (pdfPath && fs.existsSync(pdfPath)) {
    mailOptions.attachments.push({
      filename: `Resume_${job.company.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
      path: pdfPath
    });
  }

  try {
    await withTimeout(transporter.sendMail(mailOptions), 15000, 'SMTP Email Send');
    systemLog(`[Notifier] Email alert sent successfully for ${job.title}.`, 'success');
    return true;
  } catch (err) {
    systemLog(`[Notifier] Email sending error: ${err.message}`, 'error');
    return false;
  }
}

/**
 * Main entry point to send notifications for a job.
 */
async function sendJobApplicationKit(job, systemLog, config, force = false) {
  if (job.alertSent === true && !force) {
    systemLog(`[Notifier] Alert already sent for ${job.company}. Skipping.`, 'info');
    return 'skipped';
  }

  if (!config.discordWebhookUrl && !config.enableEmailAlerts) {
    return 'skipped';
  }

  if (!config.hunterApiKey) {
    systemLog(`[Notifier] Skipping alert: No Hunter API key configured.`, 'info');
    return 'skipped';
  }

  let pdfPath = null;
  if (config.enableEmailAlerts && job.tailoredResume) {
    const safeName = (job.company || 'Unknown').replace(/[^a-zA-Z0-9]/g, '_');
    pdfPath = path.join(__dirname, '..', `Resume_${safeName}.pdf`);
    
    try {
      await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const stream = fs.createWriteStream(pdfPath);
        stream.on('finish', resolve);
        stream.on('error', reject);
        doc.pipe(stream);
        renderMarkdownToPdf(doc, job.tailoredResume);
        doc.end();
      });
    } catch (err) {
      systemLog(`[Notifier] Failed to generate resume PDF: ${err.message}`, 'error');
      pdfPath = null;
    }
  }

  let discordSuccess = false;
  let emailSuccess = false;

  if (config.discordWebhookUrl) {
    discordSuccess = await sendDiscordAlert(job, config, systemLog);
  }

  if (config.enableEmailAlerts) {
    emailSuccess = await sendEmailAlert(job, config, systemLog, pdfPath);
  }

  // Cleanup PDF
  if (pdfPath && fs.existsSync(pdfPath)) {
    try { fs.unlinkSync(pdfPath); } catch (_) {}
  }

  if (discordSuccess || emailSuccess) {
    job.alertSent = true;
    if (onJobProcessedCallback) {
      try {
        await onJobProcessedCallback(job);
      } catch (err) {
        systemLog(`[Notifier] Error calling callback: ${err.message}`, 'error');
      }
    }
    return 'sent';
  } else {
    return 'failed';
  }
}

module.exports = {
  registerOnJobProcessed,
  sendJobApplicationKit
};
