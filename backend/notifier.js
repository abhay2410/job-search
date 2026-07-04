/**
 * notifier.js — Unified job alert dispatcher
 * Sends job application kit via Email (SMTP) AND Telegram in parallel.
 * Each channel has a hard timeout and fails independently.
 */

const nodemailer = require('nodemailer');
const TelegramBot = require('node-telegram-bot-api');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

let _onJobProcessedCallback = null;

function createPDFBuffer(text, type = 'resume') {
  if (!text) return null;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);
      
      // Clean up any residual markdown from old generations
      let cleanText = text
        .replace(/\*\*(.*?)\*\*/g, '$1') // remove bold asterisks
        .replace(/\*(.*?)\*/g, '$1')     // remove italic asterisks
        .replace(/^#{1,6}\s+/gm, '');    // remove header hashes at start of line
        
      const lines = cleanText.split('\n');

      if (type === 'coverLetter') {
        // Standard business letter format
        doc.font('Helvetica').fontSize(11).fillColor('#000000');
        for (let line of lines) {
          doc.text(line.trim(), { align: 'left', lineGap: 3 });
        }
      } else {
        // Resume format (smart parsing)
        for (let i = 0; i < lines.length; i++) {
          let line = lines[i].trim();
          if (!line) { doc.moveDown(0.5); continue; }

          // 1. Name
          if (i === 0) {
            doc.font('Helvetica-Bold').fontSize(16).fillColor('#000000').text(line, { align: 'center' });
            continue;
          }
          
          // 2. Title & Contact Info
          if (i === 1 || i === 2) {
            doc.font('Helvetica').fontSize(10).fillColor('#444444').text(line, { align: 'center' });
            if (i === 2) doc.moveDown(1);
            continue;
          }

          // 3. Section Headers
          const isAllcaps = line === line.toUpperCase() && /[A-Z]/.test(line);
          if (isAllcaps && line.length < 40 && !line.includes('|')) {
            doc.moveDown(0.5);
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(line);
            const y = doc.y;
            doc.lineWidth(0.5).strokeColor('#cccccc').moveTo(doc.options.margin, y).lineTo(doc.page.width - doc.options.margin, y).stroke();
            doc.moveDown(0.5);
            continue;
          }

          // 4. Bullets
          if (line.startsWith('-') || line.startsWith('•') || line.startsWith('*')) {
            line = line.replace(/^[-•*]\s*/, '•  ');
            doc.font('Helvetica').fontSize(10).fillColor('#222222').text(line, { indent: 10, lineGap: 2 });
            continue;
          }

          // 5. Job Titles / Dates / Normal Text
          const nextLine = (lines[i+1] || '').trim();
          const isJobTitle = line.length < 60 && !line.includes('.') && (nextLine.includes('|') || /[0-9]{4}/.test(nextLine));
          
          if (isJobTitle) {
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(line, { lineGap: 2 });
          } else if (line.includes('|') && /[0-9]{4}/.test(line)) {
            doc.font('Helvetica-Oblique').fontSize(10).fillColor('#555555').text(line, { lineGap: 2 });
          } else {
            doc.font('Helvetica').fontSize(10).fillColor('#222222').text(line, { lineGap: 3 });
          }
        }
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function registerOnJobProcessed(cb) {
  _onJobProcessedCallback = cb;
}

// Timeout wrapper
function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out (${ms / 1000}s)`)), ms))
  ]);
}

function buildEmailHtml(job) {
  const conf = job.confidence ? `${job.confidence}%` : 'N/A';
  const status = (job.status || 'unknown').toUpperCase();
  const location = job.location || 'Not specified';
  const careerSite = job.hrDetails?.careerSiteUrl || job.careerSiteUrl || '';
  const hrEmail = job.hrDetails?.hrEmail || job.hrEmail || '';
  const hrName = job.hrDetails?.hrName || '';
  const jobUrl = job.url || '';

  const dealBreaker = job.analysis?.dealBreaker || '';
  const keyMatches = Array.isArray(job.analysis?.keyMatches) ? job.analysis.keyMatches.join(', ') : '';
  const concerns = Array.isArray(job.analysis?.concerns) ? job.analysis.concerns.join(', ') : '';

  const coverLetterHtml = (job.coverLetter || 'Not generated yet').replace(/\n/g, '<br>');
  const coldEmailHtml = (job.coldEmail || 'Not generated yet').replace(/\n/g, '<br>');
  const tailoredResumeHtml = (job.tailoredResume || 'Not generated yet').replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Alert: ${job.title} at ${job.company}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #0f0f1a; color: #e2e8f0; margin: 0; padding: 0; }
  .container { max-width: 700px; margin: 0 auto; padding: 24px 16px; }
  .header { background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .header h1 { margin: 0 0 6px; font-size: 22px; color: #fff; }
  .header p { margin: 0; color: rgba(255,255,255,0.8); font-size: 14px; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; margin-left: 8px; }
  .badge-ready { background: #22c55e22; color: #4ade80; border: 1px solid #22c55e44; }
  .badge-review { background: #f59e0b22; color: #fbbf24; border: 1px solid #f59e0b44; }
  .card { background: #1e1e2f; border: 1px solid #2d2d44; border-radius: 10px; padding: 18px; margin-bottom: 14px; }
  .card h3 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #a5b4fc; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .meta-item label { font-size: 11px; color: #94a3b8; display: block; margin-bottom: 2px; }
  .meta-item span { font-size: 14px; color: #e2e8f0; font-weight: 500; }
  .btn { display: inline-block; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px; margin-right: 10px; margin-top: 4px; }
  .btn-primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; }
  .btn-secondary { background: #1e293b; color: #a5b4fc; border: 1px solid #334155; }
  .text-block { font-size: 13px; line-height: 1.7; color: #cbd5e1; white-space: pre-wrap; background: #12121f; border-radius: 8px; padding: 14px; border: 1px solid #1e2a3a; }
  .confidence-bar { height: 6px; background: #1e293b; border-radius: 3px; margin-top: 6px; }
  .confidence-fill { height: 6px; border-radius: 3px; background: linear-gradient(to right, #6366f1, #22c55e); }
  .footer { text-align: center; font-size: 11px; color: #4a5568; margin-top: 24px; }
  a { color: #818cf8; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${job.title} <span class="badge badge-${job.status === 'ready' ? 'ready' : 'review'}">${status}</span></h1>
    <p>${job.company} &bull; ${location}</p>
  </div>

  <!-- Quick Actions -->
  <div class="card">
    <h3>🚀 Quick Actions</h3>
    ${jobUrl ? `<a href="${jobUrl}" class="btn btn-primary">View Job on LinkedIn</a>` : ''}
    ${careerSite ? `<a href="${careerSite}" class="btn btn-secondary">Company Careers Page</a>` : ''}
    <a href="http://localhost:5000" class="btn btn-secondary">Open Dashboard</a>
  </div>

  <!-- Job Details -->
  <div class="card">
    <h3>📋 Job Details</h3>
    <div class="meta-grid">
      <div class="meta-item"><label>Confidence Score</label><span>${conf}</span>
        <div class="confidence-bar"><div class="confidence-fill" style="width:${job.confidence || 0}%"></div></div>
      </div>
      <div class="meta-item"><label>Status</label><span>${status}</span></div>
      ${hrEmail ? `<div class="meta-item"><label>HR Email</label><span><a href="mailto:${hrEmail}">${hrEmail}</a></span></div>` : ''}
      ${hrName ? `<div class="meta-item"><label>HR Contact</label><span>${hrName}</span></div>` : ''}
      ${keyMatches ? `<div class="meta-item" style="grid-column:span 2"><label>Key Matches</label><span>${keyMatches}</span></div>` : ''}
      ${concerns ? `<div class="meta-item" style="grid-column:span 2"><label>Concerns</label><span style="color:#f87171">${concerns}</span></div>` : ''}
      ${dealBreaker ? `<div class="meta-item" style="grid-column:span 2"><label>⚠️ Deal Breaker</label><span style="color:#f87171">${dealBreaker}</span></div>` : ''}
    </div>
  </div>

  <!-- Cover Letter -->
  <div class="card">
    <h3>📝 Cover Letter</h3>
    <div class="text-block">${coverLetterHtml}</div>
  </div>

  <!-- Cold Email -->
  <div class="card">
    <h3>📧 Cold Email to HR</h3>
    ${hrEmail ? `<p style="font-size:12px;color:#94a3b8;margin:0 0 10px">Send to: <a href="mailto:${hrEmail}">${hrEmail}</a></p>` : ''}
    <div class="text-block">${coldEmailHtml}</div>
  </div>

  <div class="card">
    <h3>📄 Tailored Resume</h3>
    <p style="font-size:13px;color:#a5b4fc;margin:0;">📎 Attached to this email as a PDF document.</p>
  </div>

  <div class="footer">
    <p>Sent by your Job Search AI &bull; <a href="http://localhost:5000">Open Dashboard</a></p>
  </div>
</div>
</body>
</html>`;
}

async function sendViaEmail(job, logFn, config) {
  if (config.emailEnabled === false) {
    logFn('[Email] Email notifications are turned off in config. Skipping.', 'info');
    return 'skipped';
  }

  if (!config.smtpHost || !config.smtpUser || !config.smtpPass || !config.senderEmail) {
    logFn('[Email] SMTP not configured. Skipping email notification.', 'warning');
    return 'skipped';
  }

  const recipientEmail = config.notifyEmail || config.senderEmail;

  try {
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: Number(config.smtpPort) || 587,
      secure: Boolean(config.smtpSecure),
      auth: { user: config.smtpUser, pass: config.smtpPass },
      connectionTimeout: 8000,
      greetingTimeout: 5000,
      socketTimeout: 8000
    });

    const statusEmoji = job.status === 'ready' ? '✅' : '⚠️';
    const subject = `[${job.confidence || '?'}% ATS] ${statusEmoji} Job Alert: ${job.title} at ${job.company}`;

    const attachments = [];
    
    if (job.tailoredResume) {
      try {
        const resumeBuffer = await createPDFBuffer(job.tailoredResume, 'resume');
        attachments.push({
          filename: `Abhay_Ramesh_Resume_${job.company.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
          content: resumeBuffer,
          contentType: 'application/pdf'
        });
      } catch (e) {
        logFn(`[Email] Failed to generate resume PDF: ${e.message}`, 'warning');
      }
    }
    
    if (job.coverLetter) {
      try {
        const coverBuffer = await createPDFBuffer(job.coverLetter, 'coverLetter');
        attachments.push({
          filename: `Cover_Letter_${job.company.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
          content: coverBuffer,
          contentType: 'application/pdf'
        });
      } catch (e) {
        logFn(`[Email] Failed to generate cover letter PDF: ${e.message}`, 'warning');
      }
    }

    await withTimeout(transporter.sendMail({
      from: `"Job Search AI" <${config.senderEmail}>`,
      to: recipientEmail,
      subject,
      html: buildEmailHtml(job),
      attachments,
      text: [
        `JOB ALERT: ${job.title} at ${job.company}`,
        `Status: ${job.status?.toUpperCase()}`,
        `Confidence: ${job.confidence || 'N/A'}%`,
        `Location: ${job.location || 'N/A'}`,
        `URL: ${job.url || 'N/A'}`,
        '', '--- COVER LETTER ---', job.coverLetter || 'Not generated',
        '', '--- COLD EMAIL ---', job.coldEmail || 'Not generated',
        '', '--- TAILORED RESUME ---', '(Attached as PDF)',
      ].join('\n')
    }), 10000, 'Email');

    logFn(`[Email] ✅ Sent alert for "${job.title}" at ${job.company} → ${recipientEmail}`, 'success');
    return 'sent';
  } catch (err) {
    logFn(`[Email] Failed to send alert: ${err.message}`, 'error');
    return 'failed';
  }
}

async function sendViaTelegram(job, logFn, config) {
  if (!config.telegramBotToken || !config.telegramChatId) return 'skipped';

  const statusEmoji = job.status === 'ready' ? '✅' : '⚠️';
  const hrEmail = job.hrDetails?.hrEmail || job.hrEmail || '';
  const careerSite = job.hrDetails?.careerSiteUrl || job.careerSiteUrl || '';

  try {
    const bot = new TelegramBot(config.telegramBotToken, {
      polling: false,
      request: {
        agentOptions: {
          family: 4
        }
      }
    });

    // 1. Send High-Level Info Message
    const infoMsg = [
      `${statusEmoji} *[${job.confidence || '?'}% ATS]* *${escTg(job.title)}* at *${escTg(job.company)}*`,
      `📍 ${escTg(job.location || 'N/A')} | Status: ${(job.status || '').toUpperCase()}`,
      job.url ? `🔗 [View on LinkedIn](${job.url})` : '',
      careerSite ? `🏢 [Company Careers](${careerSite})` : '',
      hrEmail ? `📧 HR Email: ${escTg(hrEmail)}` : '',
      `🚀 Apply: /apply\\_${job.id}`,
      `🔖 Tag: /tag\\_interested\\_${job.id} | /tag\\_maybe\\_${job.id} | /tag\\_not\\_interested\\_${job.id}`
    ].filter(Boolean).join('\n');

    await withTimeout(
      bot.sendMessage(config.telegramChatId, infoMsg, { parse_mode: 'Markdown', disable_web_page_preview: true }),
      10000, 'Telegram Info'
    );

    // 2. Send Cover Letter if available
    if (job.coverLetter) {
      const coverMsg = [
        `📝 *COVER LETTER FOR ${escTg(job.company)}*`,
        '```',
        job.coverLetter.substring(0, 4000),
        '```'
      ].join('\n');
      try {
        await withTimeout(
          bot.sendMessage(config.telegramChatId, coverMsg, { parse_mode: 'Markdown', disable_web_page_preview: true }),
          10000, 'Telegram Cover Letter'
        );
      } catch (err) {
        logFn(`[Telegram] Failed to send cover letter: ${err.message}`, 'warning');
      }
    }

    // 3. Send Cold Email if available
    if (job.coldEmail) {
      const coldMsg = [
        `📧 *COLD EMAIL FOR ${escTg(job.company)}*`,
        '```',
        job.coldEmail.substring(0, 4000),
        '```'
      ].join('\n');
      try {
        await withTimeout(
          bot.sendMessage(config.telegramChatId, coldMsg, { parse_mode: 'Markdown', disable_web_page_preview: true }),
          10000, 'Telegram Cold Email'
        );
      } catch (err) {
        logFn(`[Telegram] Failed to send cold email: ${err.message}`, 'warning');
      }
    }

    // 4. Send tailored resume PDF
    if (job.tailoredResume) {
      try {
        const resumeBuffer = await createPDFBuffer(job.tailoredResume, 'resume');
        const filename = `Abhay_Ramesh_Resume_${job.company.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
        await withTimeout(
          bot.sendDocument(config.telegramChatId, resumeBuffer, {}, { filename, contentType: 'application/pdf' }),
          15000, 'Telegram PDF'
        );
      } catch (err) {
        logFn(`[Telegram] Failed to send PDF: ${err.message}`, 'warning');
      }
    }

    logFn(`[Telegram] ✅ Sent alert for "${job.title}" at ${job.company}`, 'success');
    return 'sent';
  } catch (err) {
    logFn(`[Telegram] Failed: ${err.message}`, 'warning');
    return 'failed';
  }
}

function escTg(text) {
  return (text || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

async function sendJobApplicationKit(job, logFn = console.log, config = {}, force = false) {
  // Gulf location filter (unless forced)
  if (!force) {
    const gulfLocations = config.gulfLocations || [];
    const jobLocation = (job.location || '').toLowerCase();
    const isGulfJob = gulfLocations.length === 0 || gulfLocations.some(g => jobLocation.includes(g.toLowerCase()));
    if (!isGulfJob && gulfLocations.length > 0) {
      logFn(`[Alerts] Skipping non-Gulf job: "${job.title}" (${job.location})`, 'info');
      return 'skipped';
    }
  }

  let emailResult = 'skipped';
  let telegramResult = 'skipped';

  // Fire both channels in parallel with independent timeouts
  const [emailOutcome, telegramOutcome] = await Promise.allSettled([
    sendViaEmail(job, logFn, config),
    sendViaTelegram(job, logFn, config)
  ]);

  emailResult = emailOutcome.status === 'fulfilled' ? emailOutcome.value : 'failed';
  telegramResult = telegramOutcome.status === 'fulfilled' ? telegramOutcome.value : 'failed';

  // Trigger registered callback
  if (_onJobProcessedCallback) {
    try { await _onJobProcessedCallback(job); } catch (e) {}
  }

  // Return 'sent' if at least one channel succeeded
  if (emailResult === 'sent' || telegramResult === 'sent') return 'sent';
  if (emailResult === 'skipped' && telegramResult === 'skipped') return 'skipped';
  return 'failed';
}

module.exports = { sendJobApplicationKit, registerOnJobProcessed, createPDFBuffer };
