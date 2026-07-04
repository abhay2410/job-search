const express = require('express');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const notifier = require('./notifier');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(compression());
app.use(cors());
app.use(express.json());

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let logsBuffer = [];
let activeClients = [];

// Promise-based Mutex for thread-safety / concurrency safeguard
class Mutex {
  constructor() {
    this.queue = Promise.resolve();
  }
  acquire() {
    let release;
    const pending = new Promise(resolve => {
      release = resolve;
    });
    const ticket = this.queue.then(() => release);
    this.queue = this.queue.then(() => pending).catch(() => {});
    return ticket;
  }
}

const dbMutex = new Mutex();
const configMutex = new Mutex();

function systemLog(message, type = 'info') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type // 'info', 'success', 'warning', 'error', 'system'
  };
  logsBuffer.push(logEntry);
  if (logsBuffer.length > 500) {
    logsBuffer.shift();
  }
  // Send to SSE clients
  activeClients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// Helpers for reading/writing config and DB (Asynchronous and Locked)
async function readConfig() {
  const release = await configMutex.acquire();
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return {};
    }
    const data = await fs.promises.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading config:', err);
    return {};
  } finally {
    release();
  }
}

async function writeConfig(config) {
  const release = await configMutex.acquire();
  try {
    await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing config:', err);
    return false;
  } finally {
    release();
  }
}

const sqliteDb = require('./db');

let dbCache = null;

async function readDatabaseInternal() {
  const jobs = sqliteDb.getAllJobs();
  let savedAnswers = {};
  const answersPath = path.join(__dirname, '..', 'answers.json');
  try {
    if (fs.existsSync(answersPath)) {
      savedAnswers = JSON.parse(await fs.promises.readFile(answersPath, 'utf8'));
    }
  } catch (err) {}
  return { jobs, savedAnswers };
}

async function writeDatabaseInternal(db) {
  // We use this only for full syncs if needed, though mutateDatabase handles it better.
  for (const job of db.jobs) {
    sqliteDb.upsertJob(job);
  }
  const answersPath = path.join(__dirname, '..', 'answers.json');
  await fs.promises.writeFile(answersPath, JSON.stringify(db.savedAnswers || {}, null, 2), 'utf8');
  return true;
}

async function readDatabase() {
  if (dbCache) return dbCache;
  const release = await dbMutex.acquire();
  try {
    if (dbCache) return dbCache;
    dbCache = await readDatabaseInternal();
    return dbCache;
  } finally {
    release();
  }
}

async function writeDatabase(db) {
  const release = await dbMutex.acquire();
  try {
    const success = await writeDatabaseInternal(db);
    if (success) dbCache = db;
    return success;
  } finally {
    release();
  }
}

// Transaction wrapper for atomic read-mutate-write operations using SQLite
async function mutateDatabase(mutationFn) {
  const release = await dbMutex.acquire();
  try {
    const db = await readDatabaseInternal();
    
    // Snapshot to detect changes
    const originalJobs = new Map(db.jobs.map(j => [j.id, JSON.stringify(j)]));
    const originalAnswers = JSON.stringify(db.savedAnswers);

    const result = await mutationFn(db);

    // Write only changed jobs to SQLite
    const currentIds = new Set();
    for (const job of db.jobs) {
      currentIds.add(job.id);
      const originalStr = originalJobs.get(job.id);
      if (!originalStr || originalStr !== JSON.stringify(job)) {
        sqliteDb.upsertJob(job);
      }
    }

    // Handle deletions
    for (const oldId of originalJobs.keys()) {
      if (!currentIds.has(oldId)) {
        sqliteDb.db.prepare('DELETE FROM jobs WHERE id = ?').run(oldId);
      }
    }

    // Handle answers
    if (JSON.stringify(db.savedAnswers) !== originalAnswers) {
      const answersPath = path.join(__dirname, '..', 'answers.json');
      await fs.promises.writeFile(answersPath, JSON.stringify(db.savedAnswers || {}, null, 2), 'utf8');
    }

    dbCache = db; // Sync cache
    return result;
  } finally {
    release();
  }
}

// SSE endpoint for live logs
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send historical logs first
  logsBuffer.forEach(log => {
    res.write(`data: ${JSON.stringify(log)}\n\n`);
  });

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  activeClients.push(newClient);

  req.on('close', () => {
    activeClients = activeClients.filter(c => c.id !== clientId);
  });
});

// Config Endpoints
app.get('/api/config', async (req, res) => {
  res.json(await readConfig());
});

app.post('/api/config', async (req, res) => {
  const success = await writeConfig(req.body);
  if (success) {
    systemLog('User configuration updated.', 'success');
    // Dynamically re-initialize alerts bot with updated settings
        res.json({ success: true, config: req.body });
  } else {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Helper to sync an array of jobs to Google Sheets (Batched in a single payload)
async function syncJobsToGoogleSheets(jobsArray) {
  const config = await readConfig();
  if (!config.googleSheetsUrl) {
    systemLog('Google Sheets URL not configured; skipping automatic sync.', 'warning');
    return;
  }

  const targetStatuses = ['scored', 'review', 'ready', 'submitted'];
  const jobsToSync = jobsArray.filter(j => targetStatuses.includes(j.status));
  if (jobsToSync.length === 0) {
    return;
  }

  systemLog(`Syncing ${jobsToSync.length} jobs to Google Sheets in a batch request...`, 'info');
  try {
    const items = jobsToSync.map(job => ({
      id: job.id,
      company: job.company,
      title: job.title,
      url: job.url,
      location: job.location || "",
      score: job.score || "",
      scoreReason: job.scoreReason || "",
      status: job.status,
      timestamp: job.timestamp,
      coldEmail: job.coldEmail || "",
      posterName: job.poster?.name || "",
      posterTitle: job.poster?.title || "",
      posterUrl: job.poster?.url || ""
    }));

    const response = await fetch(config.googleSheetsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'batch', items })
    });

    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      throw new Error('Google Sheets URL returned HTML instead of JSON. Ensure the Web App deployment is configured with "Who has access: Anyone".');
    }

    if (result && result.success) {
      systemLog(`Google Sheets sync completed successfully for ${jobsToSync.length} jobs.`, 'success');
    } else {
      console.error('Failed to sync batch to Google Sheets:', result ? result.error : 'Empty response');
      systemLog('Failed to sync batch to Google Sheets: ' + (result ? result.error : 'Empty response'), 'error');
    }
  } catch (err) {
    systemLog(`Error during Google Sheets sync: ${err.message}`, 'error');
  }
}

// Google Sheets Sync Endpoint (Optimized via Batching)
app.post('/api/sync/sheets', async (req, res) => {
  const config = await readConfig();
  if (!config.googleSheetsUrl) {
    return res.status(400).json({ error: 'Google Sheets Apps Script URL not configured' });
  }

  res.json({ success: true, message: 'Syncing started' });
  systemLog('Starting Google Sheets synchronization...', 'info');

  try {
    const db = await readDatabase();
    const jobs = db.jobs || [];

    if (jobs.length === 0) {
      systemLog('No jobs found in database to sync.', 'warning');
      return;
    }

    await syncJobsToGoogleSheets(jobs);
  } catch (err) {
    systemLog(`Error during Google Sheets sync: ${err.message}`, 'error');
  }
});

// Jobs Endpoints
app.get('/api/jobs', async (req, res) => {
  res.json((await readDatabase()).jobs);
});

// Manual Job Import
app.post('/api/jobs/import', async (req, res) => {
  const { title, company, url, description } = req.body;
  if (!title || !company || !description) {
    return res.status(400).json({ error: 'Missing title, company, or description' });
  }

  const newJob = {
    id: 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    title,
    company,
    url: url || '',
    datePosted: new Date().toISOString().split('T')[0],
    description,
    status: 'discovered',
    score: null,
    scoreReason: null,
    analysis: null,
    tailoredResume: null,
    coverLetter: null,
    confidence: null,
    submissionLogs: [],
    timestamp: new Date().toISOString()
  };

  const result = await mutateDatabase(db => {
    const exists = db.jobs.find(j => (url && j.url === url) || (j.title === title && j.company === company));
    if (exists) {
      return { error: 'Job already exists' };
    }
    db.jobs.push(newJob);
    return { success: true, job: newJob };
  });

  if (result.error) {
    systemLog(`Job import skipped: "${title}" at ${company} already exists in DB`, 'warning');
    return res.status(400).json({ error: result.error });
  }

  systemLog(`Manually imported job: "${title}" at ${company}`, 'success');
  res.json(result);
});

// Update Job Fields (like tailored text or custom status change)
app.post('/api/jobs/edit', async (req, res) => {
  const { id, tailoredResume, coverLetter, coldEmail, status, score } = req.body;
  
  const result = await mutateDatabase(db => {
    const index = db.jobs.findIndex(j => j.id === id);
    if (index === -1) {
      return { error: 'Job not found' };
    }

    if (tailoredResume !== undefined) db.jobs[index].tailoredResume = tailoredResume;
    if (coverLetter !== undefined) db.jobs[index].coverLetter = coverLetter;
    if (coldEmail !== undefined) db.jobs[index].coldEmail = coldEmail;
    if (status !== undefined) {
      systemLog(`Job "${db.jobs[index].title}" status updated from ${db.jobs[index].status} to ${status}`, 'info');
      db.jobs[index].status = status;
    }
    if (score !== undefined) db.jobs[index].score = score;

    return { success: true, job: db.jobs[index] };
  });

  if (result.error) {
    return res.status(404).json({ error: result.error });
  }
  res.json(result);
});

// Send recruiter cold email via SMTP
app.post('/api/jobs/send-email', async (req, res) => {
  const { id, toEmail, subject, emailBody } = req.body;
  if (!id || !toEmail || !subject || !emailBody) {
    return res.status(400).json({ error: 'Missing job id, recipient email, subject, or email body.' });
  }

  const config = await readConfig();
  if (!config.smtpHost || !config.smtpUser || !config.smtpPass || !config.senderEmail) {
    systemLog('Email failed: SMTP settings are not fully configured in profile.', 'error');
    return res.status(400).json({ error: 'SMTP settings are not fully configured. Please setup SMTP in Profile Setup tab.' });
  }

  try {
    const nodemailer = require('nodemailer');
    
    systemLog(`Initiating cold email sending to ${toEmail} for job ID: ${id}...`, 'info');

    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: !!config.smtpSecure,
      auth: {
        user: config.smtpUser,
        pass: config.smtpPass
      }
    });

    const mailOptions = {
      from: `"${config.smtpUser.split('@')[0]}" <${config.senderEmail}>`,
      to: toEmail,
      subject: subject,
      text: emailBody
    };

    const info = await transporter.sendMail(mailOptions);
    systemLog(`Cold email successfully sent to ${toEmail}. Message ID: ${info.messageId}`, 'success');

    // Log to job history atomically
    await mutateDatabase(db => {
      const job = db.jobs.find(j => j.id === id);
      if (job) {
        if (!job.submissionLogs) job.submissionLogs = [];
        job.submissionLogs.push(`[${new Date().toISOString()}] Cold email sent to ${toEmail} (Subject: "${subject}").`);
      }
    });

    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    systemLog(`Failed to send email to ${toEmail}: ${err.message}`, 'error');
    res.status(500).json({ error: `Failed to send email: ${err.message}` });
  }
});

// Import Pipeline Modules lazily to avoid loading errors if setup is in progress
const getGeminiModule = () => require('./gemini');
const getScraperModule = () => require('./scraper');
const getApplierModule = () => require('./applier');
const getLlmProvider = () => require('./llmProvider').createProxy(systemLog);

// STAGE 1 - Discovery (Scraper run)
// STAGE 1 - Discovery (Scraper run)
app.post('/api/jobs/scrape', async (req, res) => {
  const { keyword, location } = req.body;
  res.json({ success: true, message: 'Scraping started' });

  systemLog(`Starting job discovery for Keyword: "${keyword}", Location: "${location}"...`, 'info');
  try {
    const config = await readConfig();
    const scraper = getScraperModule();
    
    // Scrape jobs
    const jobs = await scraper.scrapeJobs(keyword, location, config, systemLog);
    
    const newJobs = [];
    let newlyDiscoveredCount = 0;

    await mutateDatabase(db => {
      for (const job of jobs) {
        // Deduplicate against database and blacklist companies
        const isBlacklisted = config.blacklistCompanies.some(bc => 
          job.company.toLowerCase().includes(bc.toLowerCase())
        );
        if (isBlacklisted) {
          systemLog(`Skipped blacklisted company: ${job.company}`, 'warning');
          continue;
        }

        const exists = db.jobs.find(j => j.url === job.url || (j.title === job.title && j.company === job.company));
        if (!exists) {
          const newJob = {
            id: 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            ...job,
            status: 'discovered',
            score: null,
            scoreReason: null,
            analysis: null,
            tailoredResume: null,
            coverLetter: null,
            confidence: null,
            submissionLogs: [],
            timestamp: new Date().toISOString()
          };
          db.jobs.push(newJob);
          newJobs.push(newJob);
          newlyDiscoveredCount++;
        }
      }
    });
    
    await syncJobsToGoogleSheets(newJobs);
    systemLog(`Job discovery complete. Discovered ${jobs.length} raw jobs, added ${newlyDiscoveredCount} new jobs to pipeline.`, 'success');
  } catch (err) {
    systemLog(`Error during job discovery: ${err.message}`, 'error');
  }
});

// STAGE 2 - Scoring
app.post('/api/jobs/score', async (req, res) => {
  res.json({ success: true, message: 'Scoring started' });
  systemLog('Starting job description scoring pipeline...', 'info');

  try {
    const config = await readConfig();
    if (!config.geminiApiKey && (!config.llmFallbackProvider || config.llmFallbackProvider !== 'local')) {
      systemLog('Scoring failed: No API key configured and no local fallback set.', 'error');
      return;
    }
    if (!config.masterResume) {
      systemLog('Scoring failed: Missing Master Resume in configuration', 'error');
      return;
    }

    const llm = getLlmProvider();
    const db = await readDatabase();
    
    // Find all 'discovered' jobs
    const discoveredJobIds = db.jobs.filter(j => j.status === 'discovered' || j.score === null).map(j => j.id);
    
    if (discoveredJobIds.length === 0) {
      systemLog('No unscored jobs found in database.', 'warning');
      return;
    }

    for (const jobId of discoveredJobIds) {
      const currentDb = await readDatabase();
      const job = currentDb.jobs.find(j => j.id === jobId);
      if (!job) continue;

      systemLog(`Scoring job: "${job.title}" at ${job.company}...`, 'info');
      try {
        const result = await llm.scoreJob(job, config);
        
        await mutateDatabase(dbMut => {
          const targetJob = dbMut.jobs.find(j => j.id === jobId);
          if (targetJob) {
            targetJob.score = result.score;
            targetJob.scoreReason = result.reason;
            
            // Auto filter or flag (Score >= 6 passes to scored for analysis)
            if (result.score >= 6) {
              targetJob.status = 'scored';
              systemLog(`Job passed scoring! Score: ${result.score}/10. Reason: ${result.reason}`, 'success');
            } else {
              targetJob.status = 'skipped';
              systemLog(`Job filtered out. Score: ${result.score}/10. Reason: ${result.reason}`, 'info');
            }
          }
        });
      } catch (err) {
        systemLog(`Failed to score "${job.title}" at ${job.company}: ${err.message}`, 'error');
      }
    }
    
    systemLog('Job scoring complete.', 'success');
  } catch (err) {
    systemLog(`Error during job scoring pipeline: ${err.message}`, 'error');
  }
});

// STAGE 3, 4 & 5 - Deep Job Analysis, Resume Tailoring, Cover Letter Generation
app.post('/api/jobs/analyze', async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing job id' });
  }

  res.json({ success: true, message: 'Deep analysis and tailoring started' });
  
  try {
    const config = await readConfig();
    const llm = getLlmProvider();
    const db = await readDatabase();
    
    const job = db.jobs.find(j => j.id === id);
    if (!job) {
      systemLog(`Analysis failed: Job ID ${id} not found`, 'error');
      return;
    }

    systemLog(`Starting Deep Analysis & Tailoring for "${job.title}" at ${job.company}...`, 'info');

    // Stage 3 - Deep Analysis
    systemLog(`Extracting keywords, skills and red flags...`, 'info');
    const analysis = await llm.analyzeJob(job, config);
    
    if (analysis.dealBreaker) {
      systemLog(`[DEAL-BREAKER DETECTED] ${analysis.dealBreaker}`, 'warning');
    }

    // Stage 4 - Resume Tailoring
    systemLog(`Tailoring resume bullet points to front-load relevant skills...`, 'info');
    const tailoredResume = await llm.tailorResume(job, analysis, config);

    // Stage 5 - Cover Letter Generation
    systemLog(`Generating personalized cover letter matching company culture...`, 'info');
    const coverLetter = await llm.generateCoverLetter(job, analysis, config);

    // Stage 5.5 - Cold Email Generation
    systemLog(`Generating personalized cold email for recruiter outreach...`, 'info');
    const coldEmail = await llm.generateColdEmail(job, analysis, config, job.poster || null);

    // Confidence scoring
    systemLog(`Calculating application confidence score...`, 'info');
    const confidence = await llm.calculateConfidence(job, analysis, tailoredResume, coverLetter, config);

    const status = 'ready';
    systemLog(`Job analysis ready! Confidence score: ${confidence}%. Ready to apply.`, 'success');

    // Send to Alerts automatically
    let alertSentResult = null;
    try {
      const tempJob = { ...job, analysis, tailoredResume, coverLetter, coldEmail, confidence, status };
      const result = await notifier.sendJobApplicationKit(tempJob, systemLog, config);
      if (result === 'sent') {
        alertSentResult = 'sent';
      } else if (result === 'skipped') {
        alertSentResult = 'skipped';
      }
    } catch (alertsErr) {
      systemLog(`Failed to auto-send to Alerts: ${alertsErr.message}`, 'error');
    }

    // Mutate database atomically
    await mutateDatabase(dbMut => {
      const targetJob = dbMut.jobs.find(j => j.id === id);
      if (targetJob) {
        targetJob.analysis = analysis;
        targetJob.tailoredResume = tailoredResume;
        targetJob.coverLetter = coverLetter;
        targetJob.coldEmail = coldEmail;
        targetJob.confidence = confidence;
        targetJob.status = status;
        if (alertSentResult === 'sent') {
          targetJob.alertSent = true;
        } else if (alertSentResult === 'skipped') {
          targetJob.alertSent = 'skipped';
        }
      }
    });

  } catch (err) {
    systemLog(`Error during job analysis/tailoring: ${err.message}`, 'error');
  }
});

// STAGE 6 - Application Submission (Playwright applier)
app.post('/api/jobs/apply', async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing job id' });
  }

  try {
    const db = await readDatabase();
    const job = db.jobs.find(j => j.id === id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const config = await readConfig();
    const exporter = require('./exporter');
    
    systemLog(`Generating application assets for "${job.title}" at ${job.company}...`, 'info');
    
    const result = await exporter.exportJobAssets(job, config, systemLog);
    
    if (result.success) {
      await mutateDatabase(dbMut => {
        const targetJob = dbMut.jobs.find(j => j.id === id);
        if (targetJob) {
          targetJob.status = 'exported';
          targetJob.folderPath = result.relativePath;
          if (!targetJob.submissionLogs) targetJob.submissionLogs = [];
          targetJob.submissionLogs.push(`[${new Date().toISOString()}] Assets successfully generated in: ${result.relativePath}`);
        }
      });
      
      // Option A: Send the full application kit (details + PDF resume + cover letter) to Telegram/Email as a mobile backup
      try {
        systemLog(`Sending job application kit to Telegram/Email as mobile backup...`, 'info');
        await notifier.sendJobApplicationKit({ ...job, status: 'exported' }, systemLog, config, true);
      } catch (alertErr) {
        systemLog(`Failed to send Telegram backup: ${alertErr.message}`, 'warning');
      }

      systemLog(`Assets exported successfully to: ${result.relativePath}`, 'success');
      return res.json({ 
        success: true, 
        message: `Assets exported to ${result.relativePath}`, 
        relativePath: result.relativePath 
      });
    } else {
      systemLog(`Failed to export assets: ${result.error}`, 'error');
      return res.status(500).json({ error: `Export failed: ${result.error}` });
    }
  } catch (err) {
    systemLog(`Error during asset export: ${err.message}`, 'error');
    return res.status(500).json({ error: err.message });
  }
});

// STAGE 7 - Mark Job as Manually Applied
app.post('/api/jobs/mark-applied', async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing job id' });
  }

  try {
    const db = await readDatabase();
    const job = db.jobs.find(j => j.id === id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    await mutateDatabase(dbMut => {
      const targetJob = dbMut.jobs.find(j => j.id === id);
      if (targetJob) {
        targetJob.status = 'submitted';
        if (!targetJob.submissionLogs) targetJob.submissionLogs = [];
        targetJob.submissionLogs.push(`[${new Date().toISOString()}] Manually applied and marked as submitted.`);
      }
    });

    systemLog(`Job "${job.title}" at ${job.company} marked as manually applied.`, 'success');
    return res.json({ success: true, message: 'Job marked as applied.' });
  } catch (err) {
    systemLog(`Error marking job as applied: ${err.message}`, 'error');
    return res.status(500).json({ error: err.message });
  }
});

// Sync all finished jobs to Alerts that have not been sent yet
app.post('/api/jobs/sync-alerts', async (req, res) => {
  const db = await readDatabase();
  const config = await readConfig();
  
  // Find all jobs in 'ready' or 'review' state that haven't been sent/skipped
  const finishedJobs = db.jobs.filter(j => 
    (j.status === 'ready' || j.status === 'review') && 
    !j.alertSent
  );

  if (finishedJobs.length === 0) {
    return res.json({ success: true, message: 'No new finished jobs to sync.', count: 0 });
  }

  res.json({ success: true, message: `Syncing ${finishedJobs.length} jobs to Alerts...`, count: finishedJobs.length });

  // Sync in background to avoid blocking response
  (async () => {
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const sentIds = [];
    const skippedIds = [];

    for (const job of finishedJobs) {
      try {
        const result = await notifier.sendJobApplicationKit(job, systemLog, config);
        if (result === 'sent') {
          sentIds.push(job.id);
          sentCount++;
        } else if (result === 'skipped') {
          skippedIds.push(job.id);
          skippedCount++;
        } else {
          failedCount++;
        }
      } catch (err) {
        failedCount++;
        systemLog(`Failed syncing job ${job.id} to Alerts: ${err.message}`, 'error');
      }
      // Wait a short delay to prevent message rate limits on Alerts
      await delay(1000);
    }
    
    // Save database updates atomically
    await mutateDatabase(dbMut => {
      sentIds.forEach(id => {
        const job = dbMut.jobs.find(j => j.id === id);
        if (job) job.alertSent = true;
      });
      skippedIds.forEach(id => {
        const job = dbMut.jobs.find(j => j.id === id);
        if (job) job.alertSent = 'skipped';
      });
    });

    systemLog(`Alerts sync completed. Sent: ${sentCount}, Skipped (Gulf filter): ${skippedCount}, Failed: ${failedCount}`, 'success');
  })().catch(err => {
    systemLog(`Error during Alerts sync background process: ${err.message}`, 'error');
  });
});

// Send a single job to Alerts manually (supports forcing bypass of Gulf filter)
app.post('/api/jobs/send-alert', async (req, res) => {
  const { id, force = false } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing job id' });
  }

  const db = await readDatabase();
  const job = db.jobs.find(j => j.id === id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const config = await readConfig();
  systemLog(`Manually sending job "${job.title}" at ${job.company} to Alerts...`, 'info');

  try {
    const result = await notifier.sendJobApplicationKit(job, systemLog, config, force);
    if (result === 'sent') {
      await mutateDatabase(dbMut => {
        const targetJob = dbMut.jobs.find(j => j.id === id);
        if (targetJob) targetJob.alertSent = true;
      });
      res.json({ success: true, message: 'Job successfully sent to Alerts.' });
    } else if (result === 'skipped') {
      res.json({ success: false, message: 'Job skipped due to location filter. Use "force" to send anyway.' });
    } else {
      res.status(500).json({ error: 'Failed to send job to Alerts.' });
    }
  } catch (err) {
    systemLog(`Failed manual Alerts send: ${err.message}`, 'error');
    res.status(500).json({ error: `Failed to send to Alerts: ${err.message}` });
  }
});

// LLM Provider Status Endpoint
app.get('/api/llm/status', async (req, res) => {
  const config = await readConfig();
  const primary = config.llmPrimaryProvider || 'gemini';
  const fallback = config.llmFallbackProvider || 'local';
  const localModel = config.localLlmModel || 'phi3:mini';

  let localOnline = false;
  let localModels = [];
  try {
    const localLlm = require('./localLlm');
    localOnline = await localLlm.isAvailable();
    if (localOnline) {
      const tagsResp = await fetch('http://127.0.0.1:11434/api/tags');
      const tags = await tagsResp.json();
      localModels = (tags.models || []).map(m => m.name);
    }
  } catch (e) { /* Ollama not reachable */ }

  const geminiConfigured = !!config.geminiApiKey;

  res.json({
    primary,
    fallback,
    gemini: { configured: geminiConfigured },
    local: {
      online: localOnline,
      model: localModel,
      availableModels: localModels
    }
  });
});

// Clear Logs
app.post('/api/logs/clear', (req, res) => {
  logsBuffer = [];
  systemLog('System logs cleared.', 'info');
  res.json({ success: true });
});

// Purge all 'skipped' jobs from DB and clean them from Google Sheets
app.post('/api/jobs/purge-skipped', async (req, res) => {
  const db = await readDatabase();
  const skipped = db.jobs.filter(j => j.status === 'skipped');
  const skippedIds = new Set(skipped.map(j => j.id));

  if (skipped.length === 0) {
    return res.json({ success: true, removed: 0, message: 'No skipped jobs to remove.' });
  }

  // Remove from database atomically
  await mutateDatabase(dbMut => {
    dbMut.jobs = dbMut.jobs.filter(j => !skippedIds.has(j.id));
  });
  systemLog(`Purged ${skipped.length} skipped jobs from local database.`, 'success');

  // Send delete requests to Google Sheets
  const config = await readConfig();
  let sheetsDeleted = 0;
  let sheetsFailed = 0;
  if (config.googleSheetsUrl) {
    systemLog(`Sending ${skipped.length} delete requests to Google Sheets...`, 'info');
    for (const job of skipped) {
      try {
        const response = await fetch(config.googleSheetsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: job.id })
        });
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); } catch (e) { result = null; }
        if (result && result.success) {
          sheetsDeleted++;
        } else {
          sheetsFailed++;
        }
      } catch (err) {
        sheetsFailed++;
        console.error(`Failed to delete job ${job.id} from Sheets:`, err.message);
      }
    }
    systemLog(`Google Sheets cleanup: ${sheetsDeleted} rows deleted, ${sheetsFailed} failed (failed rows may not have been in the sheet).`, 'info');
  }

  res.json({
    success: true,
    removed: skipped.length,
    sheetsDeleted,
    sheetsFailed,
    message: `Removed ${skipped.length} skipped jobs from database. Sheet: ${sheetsDeleted} rows deleted.`
  });
});

// Launch persistent browser for portal setup and manual login
app.post('/api/browser/launch', (req, res) => {
  const { chromium } = require('playwright');
  const userDataDir = path.join(__dirname, '..', 'user_data');
  const launchOptions = {
    headless: false,
    slowMo: 100,
    viewport: { width: 1280, height: 800 }
  };

  res.json({ success: true, message: 'Automation browser launched in a new window.' });

  systemLog('Launching automation browser for portal setup...', 'info');

  (async () => {
    try {
      const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();

      systemLog('Browser opened. Navigating to LinkedIn login page...', 'info');
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
      systemLog('LinkedIn loaded. Please sign in, complete any verification, and close the browser window when finished.', 'warning');

      await page.waitForEvent('close', { timeout: 0 });
      await context.close();
      systemLog('Automation browser closed. All sessions have been saved.', 'success');
    } catch (err) {
      systemLog(`Automation browser error: ${err.message}`, 'error');
    }
  })();
});

// Helper delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let isAutoDiscoveryRunning = false;
let isAutoApplyRunning = false; // Separate lock — apply sessions can outlive the discovery cycle
const APPLY_TIMEOUT_MS = 15 * 60 * 1000; // 15-minute max per job application

// --- Daily Apify Budget Tracker (File-Persisted) ---
const APIFY_BUDGET_FILE = path.join(__dirname, '..', 'apify_budget.json');

function loadApifyBudget() {
  try {
    if (fs.existsSync(APIFY_BUDGET_FILE)) {
      const data = JSON.parse(fs.readFileSync(APIFY_BUDGET_FILE, 'utf8'));
      const today = new Date().toDateString();
      if (data.date === today) {
        return { count: data.count || 0, date: today, sourceIndex: data.sourceIndex || 0 };
      }
    }
  } catch (_) {}
  return { count: 0, date: new Date().toDateString(), sourceIndex: 0 };
}

function saveApifyBudget(count, date, sourceIndex) {
  try {
    fs.writeFileSync(APIFY_BUDGET_FILE, JSON.stringify({ count, date, sourceIndex }, null, 2), 'utf8');
  } catch (_) {}
}

// Load persisted state on startup
let _budget = loadApifyBudget();
let apifyDailyCount = _budget.count;
let apifyBudgetResetDate = _budget.date;

function getApifyBudgetStatus(config) {
  const today = new Date().toDateString();
  if (apifyBudgetResetDate !== today) {
    apifyDailyCount = 0;
    apifyBudgetResetDate = today;
    saveApifyBudget(0, today, localSourceIndex);
    systemLog('[Apify Budget] Daily counter reset for new day.', 'info');
  }
  const limit = config.apifyDailyLimit || 3;
  return { used: apifyDailyCount, limit, available: apifyDailyCount < limit };
}

function incrementApifyBudget() {
  apifyDailyCount++;
  saveApifyBudget(apifyDailyCount, apifyBudgetResetDate, localSourceIndex);
}

// --- Round-Robin Source Rotation (File-Persisted) ---
const LOCAL_SOURCES = ['linkedin', 'indeed', 'gulftalent', 'google'];
let localSourceIndex = _budget.sourceIndex || 0; // resume from last source
function getNextLocalSource() {
  const source = LOCAL_SOURCES[localSourceIndex % LOCAL_SOURCES.length];
  localSourceIndex++;
  saveApifyBudget(apifyDailyCount, apifyBudgetResetDate, localSourceIndex); // persist rotation
  return source;
}


// 24/7 background scheduler loop
async function runAutoDiscovery() {
  if (isAutoDiscoveryRunning) {
    systemLog('Auto-discovery is already running. Skipping this cycle.', 'warning');
    return;
  }
  
  isAutoDiscoveryRunning = true;
  systemLog('Starting 24/7 background auto-discovery cycle...', 'system');
  
  try {
    const config = await readConfig();
    const targetRoles = config.targetRoles || [];
    const locations = config.locations || [];
    
    if (targetRoles.length === 0 || locations.length === 0) {
      systemLog('Auto-discovery skipped: targetRoles or locations is empty in config', 'warning');
      isAutoDiscoveryRunning = false;
      return;
    }
    
    const allCombos = [];
    for (const role of targetRoles) {
      for (const loc of locations) {
        allCombos.push({ role, loc });
      }
    }
    
    const N = config.autoScrapeCombinations || 3;
    const selectedCombos = [];
    const shuffled = [...allCombos].sort(() => 0.5 - Math.random());
    for (let i = 0; i < Math.min(shuffled.length, N); i++) {
      selectedCombos.push(shuffled[i]);
    }
    
    systemLog(`[Auto-Discovery] Selected combos for this cycle: ${selectedCombos.map(c => `"${c.role}" in "${c.loc}"`).join(', ')}`, 'info');
    
    const jobsToSyncMap = new Map();
    const llmDelay = config.delayBetweenLlmCallsMs || 5000;

    // --- Round-Robin: pick which local source runs this cycle ---
    const activeSource = getNextLocalSource();

    // --- Apify daily budget gate (boosts LinkedIn/Indeed cycles only) ---
    const apifyBudget = getApifyBudgetStatus(config);
    const apifyBoostAllowed = ['linkedin', 'indeed'].includes(activeSource);
    let cycleConfig = config;
    if (config.apifyEnabled && apifyBudget.available && apifyBoostAllowed) {
      systemLog(`[Apify Budget] Apify cloud boost active for "${activeSource}" cycle (${apifyBudget.used}/${apifyBudget.limit} uses today).`, 'info');
      incrementApifyBudget();
    } else if (config.apifyEnabled && !apifyBudget.available) {
      systemLog(`[Apify Budget] Daily limit reached (${apifyBudget.used}/${apifyBudget.limit} uses). Local-only this cycle.`, 'warning');
      cycleConfig = { ...config, apifyEnabled: false };
    } else {
      cycleConfig = { ...config, apifyEnabled: false }; // GulfTalent/Google cycles don't need Apify
    }

    systemLog(`[Auto-Discovery] 🔄 This cycle source: ${activeSource.toUpperCase()}`, 'info');

    for (let i = 0; i < selectedCombos.length; i++) {
      const { role, loc } = selectedCombos[i];
      systemLog(`[Auto-Discovery] Running scraper for Keyword: "${role}", Location: "${loc}" (Combo ${i+1}/${selectedCombos.length})...`, 'info');
      try {
        const scraper = getScraperModule();
        const jobs = await scraper.scrapeJobs(role, loc, cycleConfig, systemLog, null, activeSource);
        let comboNewCount = 0;
        const newJobsForCombo = [];

        await mutateDatabase(db => {
          for (const job of jobs) {
            const isBlacklisted = config.blacklistCompanies.some(bc => 
              job.company.toLowerCase().includes(bc.toLowerCase())
            );
            if (isBlacklisted) {
              systemLog(`[Auto-Discovery] Skipped blacklisted company: ${job.company}`, 'warning');
              continue;
            }

            const exists = db.jobs.find(j => j.url === job.url || (j.title === job.title && j.company === job.company));
            if (!exists) {
              const newJob = {
                id: 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                ...job,
                status: 'discovered',
                score: null,
                scoreReason: null,
                analysis: null,
                tailoredResume: null,
                coverLetter: null,
                confidence: null,
                submissionLogs: [],
                timestamp: new Date().toISOString()
              };
              db.jobs.push(newJob);
              newJobsForCombo.push(newJob);
              jobsToSyncMap.set(newJob.id, newJob);
              comboNewCount++;
            }
          }
        });

        systemLog(`[Auto-Discovery] Scraped Combo ${i+1}. Discovered ${jobs.length} jobs, added ${comboNewCount} new jobs to database.`, 'info');
      } catch (err) {
        systemLog(`[Auto-Discovery] Error scraping Combo ${role} @ ${loc}: ${err.message}`, 'error');
      }
      
      if (i < selectedCombos.length - 1) {
        systemLog(`[Auto-Discovery] Waiting 45 seconds before next combination to avoid rate limiting...`, 'info');
        await delay(45000);
      }
    }
    
    // Stage 2 - Score new jobs (one-at-a-time with delay to stay under quota)
    const currentDb = await readDatabase();
    const allUnscoredJobs = currentDb.jobs.filter(j => j.status === 'discovered' || j.score === null);
    const maxScore = config.maxJobsScoredPerRun || 5;
    const jobsToScore = allUnscoredJobs.slice(0, maxScore);

    if (allUnscoredJobs.length > maxScore) {
      systemLog(`[Auto-Discovery] ${allUnscoredJobs.length} unscored jobs found. Processing ${maxScore} this cycle (quota limit). Remaining ${allUnscoredJobs.length - maxScore} will be scored in future cycles.`, 'info');
    }

    if (jobsToScore.length > 0) {
      systemLog(`[Auto-Discovery] Scoring ${jobsToScore.length} unscored jobs...`, 'info');
      const llm = getLlmProvider();
      
      for (let i = 0; i < jobsToScore.length; i++) {
        const job = jobsToScore[i];
        systemLog(`[Auto-Discovery] Scoring job ${i + 1}/${jobsToScore.length}: "${job.title}" at ${job.company}...`, 'info');
        try {
          const result = await llm.scoreJob(job, config);
          let newStatus;
          if (result.score >= 6) {
            newStatus = 'scored';
            systemLog(`[Auto-Discovery] Job passed scoring! Score: ${result.score}/10. Reason: ${result.reason}`, 'success');
          } else {
            newStatus = 'skipped';
            systemLog(`[Auto-Discovery] Job filtered out. Score: ${result.score}/10. Reason: ${result.reason}`, 'info');
          }
          await mutateDatabase(db => {
            const t = db.jobs.find(j => j.id === job.id);
            if (t) {
              t.score = result.score;
              t.scoreReason = result.reason;
              t.status = newStatus;
              jobsToSyncMap.set(t.id, { ...t });
            }
          });
        } catch (err) {
          systemLog(`[Auto-Discovery] Failed to score "${job.title}" at ${job.company}: ${err.message}`, 'error');
        }
        if (i < jobsToScore.length - 1) {
          systemLog(`[Auto-Discovery] Waiting ${llmDelay / 1000}s before next scoring call...`, 'info');
          await delay(llmDelay);
        }
      }
    } else {
      systemLog('[Auto-Discovery] No new jobs to score.', 'info');
    }
    
    // Stage 3 - Analyze high-scoring jobs
    const finalDb = await readDatabase();
    const allScoredJobs = finalDb.jobs.filter(j => j.status === 'scored');
    const maxAnalyze = config.maxJobsAnalyzedPerRun || 2;
    const jobsToAnalyze = allScoredJobs.slice(0, maxAnalyze);

    if (allScoredJobs.length > maxAnalyze) {
      systemLog(`[Auto-Discovery] ${allScoredJobs.length} jobs ready for analysis. Processing ${maxAnalyze} this cycle (quota limit). Remaining ${allScoredJobs.length - maxAnalyze} will be analyzed in future cycles.`, 'info');
    }
    
    if (jobsToAnalyze.length > 0) {
      systemLog(`[Auto-Discovery] Analyzing ${jobsToAnalyze.length} high-scoring jobs...`, 'info');
      const llm = getLlmProvider();
      
      for (let i = 0; i < jobsToAnalyze.length; i++) {
        const job = jobsToAnalyze[i];
        systemLog(`[Auto-Discovery] Running deep analysis for job ${i + 1}/${jobsToAnalyze.length}: "${job.title}" at ${job.company}...`, 'info');
        try {
          const analysis = await llm.analyzeJob(job, config);
          if (analysis.dealBreaker) systemLog(`[Auto-Discovery] [DEAL-BREAKER DETECTED] ${analysis.dealBreaker}`, 'warning');
          await delay(llmDelay);
          const tailoredResume = await llm.tailorResume(job, analysis, config);
          await delay(llmDelay);
          const coverLetter = await llm.generateCoverLetter(job, analysis, config);
          await delay(llmDelay);
          const coldEmail = await llm.generateColdEmail(job, analysis, config, job.poster || null);
          await delay(llmDelay);
          const confidence = await llm.calculateConfidence(job, analysis, tailoredResume, coverLetter, config);

          const newStatus = 'ready';
          systemLog(`[Auto-Discovery] Job analysis ready! Confidence score: ${confidence}%. Ready to apply.`, 'success');

          // Compose temp job for Alerts before writing to DB
          const tempJob = { ...job, analysis, tailoredResume, coverLetter, coldEmail, confidence, status: newStatus };
          let alertsResult = null;
          try {
            alertsResult = await notifier.sendJobApplicationKit(tempJob, systemLog, config);
          } catch (alertsErr) {
            systemLog(`[Auto-Discovery] Failed to auto-send to Alerts: ${alertsErr.message}`, 'error');
          }

          await mutateDatabase(db => {
            const t = db.jobs.find(j => j.id === job.id);
            if (t) {
              t.analysis = analysis;
              t.tailoredResume = tailoredResume;
              t.coverLetter = coverLetter;
              t.coldEmail = coldEmail;
              t.confidence = confidence;
              t.status = newStatus;
              if (alertsResult === 'sent') t.alertSent = true;
              else if (alertsResult === 'skipped') t.alertSent = 'skipped';
              jobsToSyncMap.set(t.id, { ...t });
            }
          });
        } catch (err) {
          systemLog(`[Auto-Discovery] Error analyzing "${job.title}": ${err.message}`, 'error');
        }
        if (i < jobsToAnalyze.length - 1) {
          systemLog(`[Auto-Discovery] Waiting ${llmDelay / 1000}s before analyzing next job...`, 'info');
          await delay(llmDelay);
        }
      }
    } else {
      systemLog('[Auto-Discovery] No high-scoring jobs to analyze.', 'info');
    }
    
    // Stage 6 - Auto-Export (Generate assets) for 'ready' jobs — always runs
    const applyConfig = await readConfig();
    const applyDb = await readDatabase();
    const readyJobs = applyDb.jobs.filter(j => j.status === 'ready' && !j.folderPath);
    const maxApply = applyConfig.maxJobsAppliedPerRun || 5;
    const toApply = readyJobs.slice(0, maxApply);

    if (readyJobs.length === 0) {
      systemLog('[Auto-Export] No jobs in "ready" state to export.', 'info');
    } else {
      systemLog(`[Auto-Export] ${readyJobs.length} job(s) ready. Exporting assets for ${toApply.length} this cycle...`, 'info');
      const exporter = require('./exporter');

      for (let i = 0; i < toApply.length; i++) {
        const job = toApply[i];
        systemLog(`[Auto-Export] Generating assets for job ${i + 1}/${toApply.length}: "${job.title}" at ${job.company}...`, 'info');
        try {
          const result = await exporter.exportJobAssets(job, applyConfig, systemLog);

          await mutateDatabase(db => {
            const freshJob = db.jobs.find(j => j.id === job.id);
            if (!freshJob) return;
            freshJob.submissionLogs = freshJob.submissionLogs || [];
            if (result.success) {
              freshJob.status = 'exported';
              freshJob.folderPath = result.relativePath;
              freshJob.submissionLogs.push(`[${new Date().toISOString()}] Assets auto-generated in: ${result.relativePath}`);
              systemLog(`[Auto-Export] ✅ Successfully generated assets for "${job.title}" at ${job.company}!`, 'success');
              jobsToSyncMap.set(freshJob.id, { ...freshJob });
            } else {
              freshJob.submissionLogs.push(`[${new Date().toISOString()}] Auto-export failed: ${result.error}`);
              systemLog(`[Auto-Export] ❌ Failed to generate assets for "${job.title}": ${result.error}`, 'error');
            }
          });

          // Send Telegram notification for newly exported job
          try {
            await notifier.sendJobApplicationKit({ ...job, status: 'exported' }, systemLog, applyConfig, true);
          } catch (tgErr) {
            systemLog(`[Auto-Export] Telegram notification failed: ${tgErr.message}`, 'warning');
          }
        } catch (err) {
          systemLog(`[Auto-Export] ❌ Error exporting assets for "${job.title}" at ${job.company}: ${err.message}`, 'error');
        }

        if (i < toApply.length - 1) {
          await delay(1000);
        }
      }
    }


    // Sync to Google Sheets (single batch call)
    if (jobsToSyncMap.size > 0) {
      const jobsToSync = Array.from(jobsToSyncMap.values());
      systemLog(`[Auto-Discovery] Syncing ${jobsToSync.length} new/updated jobs to Google Sheets...`, 'info');
      await syncJobsToGoogleSheets(jobsToSync);
    } else {
      systemLog('[Auto-Discovery] No jobs to sync in this cycle.', 'info');
    }
    
    systemLog('Auto-discovery cycle completed successfully.', 'success');
  } catch (err) {
    systemLog(`Error during auto-discovery: ${err.message}`, 'error');
  } finally {
    isAutoDiscoveryRunning = false;
  }
}

// Start background discovery loop
async function startAutoDiscoveryScheduler() {
  const config = await readConfig();
  const enabled = config.autoScrapeEnabled !== false;
  if (!enabled) {
    systemLog('Auto-discovery is disabled in configuration.', 'info');
    return;
  }
  
  const intervalHours = config.autoScrapeIntervalHours || 4;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  
  systemLog(`Auto-discovery scheduler registered. Will run every ${intervalHours} hours.`, 'system');
  
  // Run immediately on startup (after 10 seconds to allow server to bind)
  setTimeout(() => {
    runAutoDiscovery().catch(err => {
      systemLog(`Error in initial auto-discovery run: ${err.message}`, 'error');
    });
  }, 10000);
  
  setInterval(() => {
    runAutoDiscovery().catch(err => {
      systemLog(`Error in scheduled auto-discovery run: ${err.message}`, 'error');
    });
  }, intervalMs);
}

// Manual trigger – full discovery + scoring cycle
app.post('/api/runNow', (req, res) => {
  res.json({ success: true, message: 'Full auto-discovery cycle triggered.' });
  runAutoDiscovery().catch(err => systemLog(`[runNow] Error: ${err.message}`, 'error'));
});

// Manual trigger – scoring + analysis only (no scraping) — clears backlog fast
app.post('/api/scoreNow', async (req, res) => {
  if (isAutoDiscoveryRunning) {
    return res.json({ success: false, message: 'Auto-discovery is already running. Try again shortly.' });
  }
  res.json({ success: true, message: 'Score-only cycle triggered. Watch the system log.' });

  isAutoDiscoveryRunning = true;
  systemLog('[scoreNow] Manual score-only cycle started...', 'system');
  try {
    const config = await readConfig();
    const llmDelay = config.delayBetweenLlmCallsMs || 5000;
    const jobsToSyncMap = new Map();
    const llm = getLlmProvider();

    // Score unscored jobs
    const db = await readDatabase();
    const allUnscored = db.jobs.filter(j => j.status === 'discovered' || j.score === null);
    const maxScore = config.maxJobsScoredPerRun || 15;
    const toScore = allUnscored.slice(0, maxScore);

    systemLog(`[scoreNow] ${allUnscored.length} unscored jobs. Scoring ${toScore.length} now...`, 'info');

    for (let i = 0; i < toScore.length; i++) {
      const job = toScore[i];
      systemLog(`[scoreNow] Scoring ${i + 1}/${toScore.length}: "${job.title}" at ${job.company}...`, 'info');
      try {
        const result = await llm.scoreJob(job, config);
        let newStatus;
        if (result.score >= 6) { newStatus = 'scored'; systemLog(`[scoreNow] ✅ ${result.score}/10 — ${job.title}`, 'success'); }
        else { newStatus = 'skipped'; systemLog(`[scoreNow] ❌ ${result.score}/10 skipped — ${job.title}`, 'info'); }
        await mutateDatabase(db => {
          const t = db.jobs.find(j => j.id === job.id);
          if (t) { t.score = result.score; t.scoreReason = result.reason; t.status = newStatus; jobsToSyncMap.set(t.id, { ...t }); }
        });
      } catch (err) {
        systemLog(`[scoreNow] Failed: ${job.title} — ${err.message}`, 'error');
      }
      if (i < toScore.length - 1) await delay(llmDelay);
    }

    // Analyze scored jobs
    const db2 = await readDatabase();
    const allScored = db2.jobs.filter(j => j.status === 'scored');
    const maxAnalyze = config.maxJobsAnalyzedPerRun || 3;
    const toAnalyze = allScored.slice(0, maxAnalyze);

    systemLog(`[scoreNow] ${allScored.length} scored jobs. Analyzing ${toAnalyze.length} now...`, 'info');

    for (let i = 0; i < toAnalyze.length; i++) {
      const job = toAnalyze[i];
      systemLog(`[scoreNow] Analyzing ${i + 1}/${toAnalyze.length}: "${job.title}"...`, 'info');
      try {
        const analysis = await llm.analyzeJob(job, config); await delay(llmDelay);
        const tailoredResume = await llm.tailorResume(job, analysis, config); await delay(llmDelay);
        const coverLetter = await llm.generateCoverLetter(job, analysis, config); await delay(llmDelay);
        const coldEmail = await llm.generateColdEmail(job, analysis, config, job.poster || null); await delay(llmDelay);
        const confidence = await llm.calculateConfidence(job, analysis, tailoredResume, coverLetter, config);
        const newStatus = 'ready';
        systemLog(`[scoreNow] Analysis done — ${job.title} → ${newStatus} (${confidence}%)`, 'success');

        // Send to Alerts automatically
        const tempJob = { ...job, analysis, tailoredResume, coverLetter, coldEmail, confidence, status: newStatus };
        let alertsResult = null;
        try {
          alertsResult = await notifier.sendJobApplicationKit(tempJob, systemLog, config);
        } catch (alertsErr) {
          systemLog(`[scoreNow] Failed to auto-send to Alerts: ${alertsErr.message}`, 'error');
        }

        await mutateDatabase(db => {
          const t = db.jobs.find(j => j.id === job.id);
          if (t) {
            t.analysis = analysis; t.tailoredResume = tailoredResume; t.coverLetter = coverLetter;
            t.coldEmail = coldEmail; t.confidence = confidence; t.status = newStatus;
            if (alertsResult === 'sent') t.alertSent = true;
            else if (alertsResult === 'skipped') t.alertSent = 'skipped';
            jobsToSyncMap.set(t.id, { ...t });
          }
        });
      } catch (err) {
        systemLog(`[scoreNow] Analysis failed: ${job.title} — ${err.message}`, 'error');
      }
      if (i < toAnalyze.length - 1) await delay(llmDelay);
    }

    // Sync to Google Sheets (single batch call)
    if (jobsToSyncMap.size > 0) await syncJobsToGoogleSheets(Array.from(jobsToSyncMap.values()));
    systemLog('[scoreNow] Manual score cycle completed.', 'success');
  } catch (err) {
    systemLog(`[scoreNow] Error: ${err.message}`, 'error');
  } finally {
    isAutoDiscoveryRunning = false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LinkedIn Recruiter Outreach Manual Trigger
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/jobs/linkedin-connect', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing job id' });

  const db = await readDatabase();
  const job = db.jobs.find(j => j.id === id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.poster || !job.poster.url) return res.status(400).json({ error: 'This job does not have recruiter LinkedIn details.' });

  res.json({ success: true, message: 'LinkedIn outreach process launched.' });

  try {
    const config = await readConfig();
    const llm = getLlmProvider();
    systemLog(`Generating connection message for "${job.title}"...`, 'info');
    const note = await llm.generateConnectionMessage(job, job.analysis, config, job.poster);

    systemLog(`Starting LinkedIn connection invite via Playwright...`, 'info');
    const outreach = require('./linkedin_outreach');
    const result = await outreach.sendLinkedInConnect(job, note, db, systemLog);

    if (result.success) {
      await mutateDatabase(dbMut => {
        const targetJob = dbMut.jobs.find(j => j.id === id);
        if (targetJob) {
          targetJob.connectionSent = result.action;
          targetJob.connectionError = null;
        }
        dbMut.linkedinOutreach = db.linkedinOutreach;
      });
      systemLog(`LinkedIn outreach succeeded: ${result.message}`, 'success');
    } else {
      await mutateDatabase(dbMut => {
        const targetJob = dbMut.jobs.find(j => j.id === id);
        if (targetJob) targetJob.connectionError = result.message;
      });
      systemLog(`LinkedIn outreach failed: ${result.message}`, 'error');
    }
  } catch (err) {
    systemLog(`Error during LinkedIn outreach: ${err.message}`, 'error');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Daily Morning Report — Telegram
// ═══════════════════════════════════════════════════════════════════════════════
async function sendDailyReport(targetChatId = null) {
  const config = await readConfig();
  const chatId = targetChatId || config.telegramChatId;
  if (!config.telegramBotToken || !chatId) {
    systemLog('[Daily Report] Telegram not configured. Skipping report.', 'warning');
    return;
  }

  const db = await readDatabase();
  const jobs = db.jobs || [];
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];

  const discoveredYesterday = jobs.filter(j => {
    if (!j.timestamp) return false;
    const d = j.timestamp.split('T')[0];
    return d === yesterdayStr || d === todayStr;
  });

  const portalCounts = {
    LinkedIn: 0,
    Indeed: 0,
    GulfTalent: 0,
    'Google Jobs': 0,
    'Other/Direct': 0
  };

  discoveredYesterday.forEach(j => {
    const url = (j.url || '').toLowerCase();
    if (url.includes('linkedin.com')) {
      portalCounts.LinkedIn++;
    } else if (url.includes('indeed.com')) {
      portalCounts.Indeed++;
    } else if (url.includes('gulftalent.com')) {
      portalCounts.GulfTalent++;
    } else if (url.includes('google.com') || url.includes('google_jobs') || url.includes('jobsora.com')) {
      portalCounts['Google Jobs']++;
    } else {
      portalCounts['Other/Direct']++;
    }
  });

  const submittedAll = jobs.filter(j => j.status === 'submitted');
  const submittedRecent = submittedAll.filter(j =>
    j.submissionLogs && j.submissionLogs.some(log => log.includes(yesterdayStr) || log.includes(todayStr))
  );

  const readyJobs = jobs.filter(j => j.status === 'ready');
  const reviewJobs = jobs.filter(j => j.status === 'review');
  const scoredJobs = jobs.filter(j => j.status === 'scored');
  const skippedJobs = jobs.filter(j => j.status === 'skipped');

  const topOpportunities = jobs
    .filter(j => (j.status === 'ready' || j.status === 'review' || j.status === 'submitted') && j.confidence)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 5);

  const appliedWithConfidence = submittedAll.filter(j => j.confidence);
  const avgConfidence = appliedWithConfidence.length > 0
    ? Math.round(appliedWithConfidence.reduce((sum, j) => sum + j.confidence, 0) / appliedWithConfidence.length)
    : 0;

  const outreach = db.linkedinOutreach || {};
  const connectionsToday = (outreach.date === todayStr || outreach.date === yesterdayStr) ? (outreach.count || 0) : 0;

  let msg = `📊 *abhii Daily Report*\n`;
  msg += `📅 ${esc(today.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))}\n\n`;

  msg += `*── Pipeline Summary ──*\n`;
  msg += `🔍 New Jobs Discovered: *${discoveredYesterday.length}*\n`;
  if (discoveredYesterday.length > 0) {
    if (portalCounts.LinkedIn > 0) msg += `   • LinkedIn: *${portalCounts.LinkedIn}*\n`;
    if (portalCounts.Indeed > 0) msg += `   • Indeed: *${portalCounts.Indeed}*\n`;
    if (portalCounts.GulfTalent > 0) msg += `   • GulfTalent: *${portalCounts.GulfTalent}*\n`;
    if (portalCounts['Google Jobs'] > 0) msg += `   • Google Jobs: *${portalCounts['Google Jobs']}*\n`;
    if (portalCounts['Other/Direct'] > 0) msg += `   • Other/Direct: *${portalCounts['Other/Direct']}*\n`;
  }
  msg += `📋 Jobs Scored \\(Pending\\): *${scoredJobs.length}*\n`;
  msg += `⏳ Awaiting Review: *${reviewJobs.length}*\n`;
  msg += `✅ Ready to Apply: *${readyJobs.length}*\n`;
  msg += `🚀 Applied \\(Recent\\): *${submittedRecent.length}*\n`;
  msg += `📨 Total Applied \\(All Time\\): *${submittedAll.length}*\n`;
  msg += `❌ Filtered Out: *${skippedJobs.length}*\n`;
  msg += `🤝 LinkedIn Connects Sent: *${connectionsToday}*\n\n`;

  if (topOpportunities.length > 0) {
    msg += `*── 🎯 Top Opportunities ──*\n`;
    for (const job of topOpportunities) {
      const statusIcon = job.status === 'submitted' ? '✅' : job.status === 'ready' ? '🟢' : '🟡';
      msg += `${statusIcon} *${esc(job.title)}*\n`;
      msg += `   📍 ${esc(job.company)} \\| ${esc(job.location || 'N/A')}\n`;
      msg += `   📊 Confidence: *${job.confidence}%* \\| Score: *${job.score || '?'}/10*\n`;
      msg += `   Status: _${esc(job.status)}_\n\n`;
    }
  }

  msg += `*── 📈 Success Estimate ──*\n`;
  if (appliedWithConfidence.length > 0) {
    msg += `Average confidence across ${appliedWithConfidence.length} applied jobs: *${avgConfidence}%*\n`;
    const estimatedCallbacks = Math.max(1, Math.round(appliedWithConfidence.length * (avgConfidence / 100) * 0.15));
    msg += `Estimated interview callbacks: *${estimatedCallbacks}\\-${estimatedCallbacks + 2}* \\(based on ${avgConfidence}% avg confidence\\)\n\n`;
  } else {
    msg += `No applications with confidence data yet\\.\n\n`;
  }

  msg += `_Report generated at ${esc(today.toLocaleTimeString('en-IN'))}_`;

  try {
    const TelegramBot = require('node-telegram-bot-api');
    const bot = new TelegramBot(config.telegramBotToken);
    await bot.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
    systemLog('[Daily Report] ✅ Morning report sent to Telegram.', 'success');
  } catch (err) {
    systemLog(`[Daily Report] Failed to send report: ${err.message}`, 'error');
    try {
      const TelegramBot = require('node-telegram-bot-api');
      const bot = new TelegramBot(config.telegramBotToken);
      const plainMsg = msg.replace(/[\\*_`]/g, '');
      await bot.sendMessage(chatId, plainMsg);
      systemLog('[Daily Report] Sent report in plain text fallback.', 'info');
    } catch (e2) {
      systemLog(`[Daily Report] Plain text fallback also failed: ${e2.message}`, 'error');
    }
  }
}

function startDailyReportScheduler() {
  readConfig().then(config => {
    if (!config.dailyReportEnabled) {
      systemLog('[Daily Report] Disabled in configuration.', 'info');
      return;
    }
    const targetHourIST = config.dailyReportHourIST || 8;
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + istOffset);
    let nextRun = new Date(nowIST);
    nextRun.setHours(targetHourIST, 0, 0, 0);
    if (nowIST >= nextRun) nextRun.setDate(nextRun.getDate() + 1);
    const msUntilNext = nextRun.getTime() - nowIST.getTime();
    const hoursUntil = (msUntilNext / (1000 * 60 * 60)).toFixed(1);
    systemLog(`[Daily Report] Scheduled for ${targetHourIST}:00 IST daily. Next report in ~${hoursUntil} hours.`, 'system');
    setTimeout(() => {
      sendDailyReport();
      setInterval(() => sendDailyReport(), 24 * 60 * 60 * 1000);
    }, msUntilNext);
  });
}

app.post('/api/send-daily-report', async (req, res) => {
  res.json({ success: true, message: 'Daily report triggered. Check Telegram.' });
  sendDailyReport().catch(err => systemLog(`[Daily Report] Manual trigger error: ${err.message}`, 'error'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Telegram Link & Command Listener
// ═══════════════════════════════════════════════════════════════════════════════
const pendingQuestions = new Map();
let telegramBotInstance = null;

function esc(text) {
  return (text || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function escHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function askUserQuestion(job, questionText, type, options = []) {
  const config = await readConfig();
  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new Error('Telegram not configured.');
  }

  // 1. Check Q&A Memory Bank first!
  const db = await readDatabase();
  db.savedAnswers = db.savedAnswers || {};
  const normQ = (questionText || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normQ && db.savedAnswers[normQ]) {
    systemLog(`[Q&A Memory] Automatically answered: "${questionText}" -> "${db.savedAnswers[normQ]}"`, 'success');
    return db.savedAnswers[normQ];
  }

  // 2. Build the interactive prompt
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(config.telegramBotToken);
  
  let promptMsg = `❓ <b>Question Alert for ${escHtml(job.company)}</b>\n` +
    `<b>${escHtml(job.title)}</b>\n\n` +
    `Question: <i>${escHtml(questionText)}</i>\n\n`;
    
  if (options.length > 0) {
    promptMsg += `Options:\n` + options.map((opt, idx) => `${idx + 1}. ${escHtml(opt)}`).join('\n') + `\n\n`;
    promptMsg += `💡 <b>Reply with the number (e.g. 1) or the text of your choice.</b>`;
  } else {
    promptMsg += `💡 <b>Reply directly to this message with your answer.</b>`;
  }

  const sentMessage = await bot.sendMessage(config.telegramChatId, promptMsg, { parse_mode: 'HTML' });

  // 3. Register in pending map
  return new Promise((resolve) => {
    pendingQuestions.set(sentMessage.message_id.toString(), {
      resolve: async (answer) => {
        // Save to Q&A database for future use!
        await mutateDatabase(dbMut => {
          dbMut.savedAnswers = dbMut.savedAnswers || {};
          dbMut.savedAnswers[normQ] = answer;
        });
        resolve(answer);
      },
      questionText,
      options
    });
  });
}

const askTelegramFn = (job) => {
  return async (questionText, type, options = []) => {
    return askUserQuestion(job, questionText, type, options);
  };
};

function initTelegramBotListener(config) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    systemLog('[Telegram Listener] Token or Chat ID not configured. Link listener disabled.', 'warning');
    return;
  }

  try {
    const TelegramBot = require('node-telegram-bot-api');
    systemLog('[Telegram Listener] Starting link listener polling...', 'info');
    
    telegramBotInstance = new TelegramBot(config.telegramBotToken, {
      polling: true,
      request: { agentOptions: { family: 4 } }
    });
    
    telegramBotInstance.on('message', async (msg) => {
      const chatId = msg.chat.id.toString();
      if (chatId !== config.telegramChatId.toString()) return; // Security check

      const text = (msg.text || '').trim();

      // Intercept replies to pending questions
      if (msg.reply_to_message && pendingQuestions.has(msg.reply_to_message.message_id.toString())) {
        const pending = pendingQuestions.get(msg.reply_to_message.message_id.toString());
        let answer = text;
        
        if (pending.options && pending.options.length > 0) {
          const idx = parseInt(text.trim(), 10);
          if (!isNaN(idx) && idx >= 1 && idx <= pending.options.length) {
            answer = pending.options[idx - 1];
          }
        }

        systemLog(`[Telegram Listener] User answered: "${pending.questionText}" -> "${answer}"`, 'info');
        pending.resolve(answer);
        pendingQuestions.delete(msg.reply_to_message.message_id.toString());
        await telegramBotInstance.sendMessage(chatId, `✅ Saved answer: *${esc(answer)}*`, { parse_mode: 'MarkdownV2' });
        return;
      }

      if (text.startsWith('http://') || text.startsWith('https://')) {
        systemLog(`[Telegram Listener] Received job URL from chat: ${text}`, 'info');
        processTelegramImportLink(telegramBotInstance, chatId, text).catch(err => {
          systemLog(`[Telegram Listener] Error processing link: ${err.message}`, 'error');
        });
      } else if (text.startsWith('/')) {
        const command = text.split(' ')[0].toLowerCase();
        systemLog(`[Telegram Listener] Received command from bot chat: ${command}`, 'info');
        
        try {
          if (command === '/help' || command === '/start') {
            const helpMsg = `🤖 *abhii Bot Commands:*\n\n` +
              `• \`/help\` \\- Show this command list\n` +
              `• \`/report\` \\- Send the daily pipeline report immediately\n` +
              `• \`/stats\` \\- View current job database stats\n` +
              `• \`/outreach\` \\- View today\\'s LinkedIn connection stats\n` +
              `• \`/applied\` \\- Show the last 5 applied jobs\n` +
              `• \`/apply\` \\- Reply to a job message with this command to apply\n` +
              `• \`/run\` \\- Trigger a full job scraper run now\n` +
              `• \`/interested\` \\- List all interested jobs with apply links\n` +
              `• \`/maybe\` \\- List all maybe jobs with apply links\n` +
              `• \`/not_interested\` \\- List all not interested jobs\n` +
              `• \`/tag_interested\` \\- Reply to a job card to tag it as Interested\n` +
              `• \`/tag_maybe\` \\- Reply to a job card to tag it as Maybe\n` +
              `• \`/tag_not_interested\` \\- Reply to a job card to tag it as Not Interested\n\n` +
              `💡 *Tip:* Tapping \`/apply_job_xxxx\` links on alert cards or list results will let you trigger the browser application manually\\!`;
            await telegramBotInstance.sendMessage(chatId, helpMsg, { parse_mode: 'MarkdownV2' });
          } 
          else if (command === '/report') {
            await telegramBotInstance.sendMessage(chatId, `⏳ Generating pipeline report...`);
            await sendDailyReport(chatId);
          } 
          else if (command === '/stats') {
            const db = await readDatabase();
            const jobs = db.jobs || [];
            const scored = jobs.filter(j => j.status === 'scored').length;
            const review = jobs.filter(j => j.status === 'review').length;
            const ready = jobs.filter(j => j.status === 'ready').length;
            const submitted = jobs.filter(j => j.status === 'submitted').length;
            const skipped = jobs.filter(j => j.status === 'skipped').length;
            
            const interested = jobs.filter(j => j.tag === 'interested').length;
            const maybe = jobs.filter(j => j.tag === 'maybe').length;
            const notInterested = jobs.filter(j => j.tag === 'not_interested').length;
            
            // Portal breakdown of tracked jobs (non-skipped)
            const trackedJobs = jobs.filter(j => j.status !== 'skipped');
            const portalTotals = { LinkedIn: 0, Indeed: 0, GulfTalent: 0, 'Google Jobs': 0, 'Other/Direct': 0 };
            trackedJobs.forEach(j => {
              const url = (j.url || '').toLowerCase();
              if (url.includes('linkedin.com')) portalTotals.LinkedIn++;
              else if (url.includes('indeed.com')) portalTotals.Indeed++;
              else if (url.includes('gulftalent.com')) portalTotals.GulfTalent++;
              else if (url.includes('google.com') || url.includes('google_jobs') || url.includes('jobsora.com')) portalTotals['Google Jobs']++;
              else portalTotals['Other/Direct']++;
            });

            const statsMsg = `📊 *Current Job Pipeline Stats:*\n\n` +
              `• Scored \\(Pending\\): *${scored}*\n` +
              `• Awaiting Review: *${review}*\n` +
              `• Ready to Apply: *${ready}*\n` +
              `• Applied: *${submitted}*\n` +
              `• Filtered Out: *${skipped}*\n\n` +
              `🌐 *By Portal (Tracked):*\n` +
              `• LinkedIn: *${portalTotals.LinkedIn}*\n` +
              `• Indeed: *${portalTotals.Indeed}*\n` +
              `• GulfTalent: *${portalTotals.GulfTalent}*\n` +
              `• Google Jobs: *${portalTotals['Google Jobs']}*\n` +
              `• Direct/Other: *${portalTotals['Other/Direct']}*\n\n` +
              `🏷️ *Tagged Jobs Status:*\n` +
              `• Interested: *${interested}*\n` +
              `• Maybe: *${maybe}*\n` +
              `• Not Interested: *${notInterested}*\n\n` +
              `Total jobs tracked: *${jobs.length}*`;
            await telegramBotInstance.sendMessage(chatId, statsMsg, { parse_mode: 'MarkdownV2' });
          } 
          else if (command === '/outreach') {
            const db = await readDatabase();
            const outreach = db.linkedinOutreach || {};
            const todayStr = new Date().toISOString().split('T')[0];
            const count = outreach.date === todayStr ? (outreach.count || 0) : 0;
            const maxVal = config.linkedinMaxConnectionsPerDay || 30;
            
            const outreachMsg = `🤝 *LinkedIn Connection Stats:*\n\n` +
              `• Sent Today: *${count} / ${maxVal}*\n` +
              `• Date: *${esc(todayStr)}*`;
            await telegramBotInstance.sendMessage(chatId, outreachMsg, { parse_mode: 'MarkdownV2' });
          }
          else if (command.startsWith('/tag_interested') || command.startsWith('/tag_maybe') || command.startsWith('/tag_not_interested')) {
            let jobId = '';
            let tag = '';
            
            if (command.startsWith('/tag_interested')) {
              tag = 'interested';
              if (command.startsWith('/tag_interested_')) {
                jobId = command.substring(16).trim();
              }
            } else if (command.startsWith('/tag_maybe')) {
              tag = 'maybe';
              if (command.startsWith('/tag_maybe_')) {
                jobId = command.substring(11).trim();
              }
            } else if (command.startsWith('/tag_not_interested')) {
              tag = 'not_interested';
              if (command.startsWith('/tag_not_interested_')) {
                jobId = command.substring(20).trim();
              }
            }

            // Fallback to reply context if jobId is not in the command
            if (!jobId && msg.reply_to_message) {
              const replyText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
              const db = await readDatabase();
              const foundJob = db.jobs.find(j => 
                replyText.includes(j.company) && replyText.includes(j.title)
              );
              if (foundJob) {
                jobId = foundJob.id;
              }
            }

            if (!jobId) {
              await telegramBotInstance.sendMessage(chatId, `❌ Could not identify the job. Reply to a job alert card with \`/tag_interested\`, \`/tag_maybe\`, or \`/tag_not_interested\`.`);
              return;
            }

            let jobTitle = '';
            let jobCompany = '';
            await mutateDatabase(dbMut => {
              const job = dbMut.jobs.find(j => j.id === jobId);
              if (job) {
                job.tag = tag;
                jobTitle = job.title;
                jobCompany = job.company;
              }
            });

            if (jobTitle) {
              const tagLabel = tag.toUpperCase().replace('_', ' ');
              await telegramBotInstance.sendMessage(chatId, `🔖 Tagged *${esc(jobTitle)}* at *${esc(jobCompany)}* as *${esc(tagLabel)}*`, { parse_mode: 'MarkdownV2' });
            } else {
              await telegramBotInstance.sendMessage(chatId, `❌ Job not found in database.`);
            }
          }
          else if (command === '/interested' || command === '/list_interested') {
            const db = await readDatabase();
            const matchingJobs = (db.jobs || [])
              .filter(j => j.tag === 'interested')
              .sort((a, b) => (b.score || 0) - (a.score || 0));

            if (matchingJobs.length === 0) {
              await telegramBotInstance.sendMessage(chatId, `No jobs tagged as *INTERESTED* yet\\.`, { parse_mode: 'MarkdownV2' });
              return;
            }

            let responseMsg = `🔖 *Interested Jobs (${matchingJobs.length}):*\n\n`;
            for (const j of matchingJobs) {
              responseMsg += `• *${esc(j.title)}* at *${esc(j.company)}*\n`;
              responseMsg += `  Score: *${j.score || '?'}/10* \\| Status: *${j.status || 'scored'}*\n`;
              responseMsg += `  ⚡ Apply: /apply\\_${j.id}\n`;
              responseMsg += `  🏷️ Change Tag: /tag\\_maybe\\_${j.id} \\| /tag\\_not\\_interested\\_${j.id}\n\n`;
            }
            await telegramBotInstance.sendMessage(chatId, responseMsg, { parse_mode: 'MarkdownV2' });
          }
          else if (command === '/maybe' || command === '/list_maybe') {
            const db = await readDatabase();
            const matchingJobs = (db.jobs || [])
              .filter(j => j.tag === 'maybe')
              .sort((a, b) => (b.score || 0) - (a.score || 0));

            if (matchingJobs.length === 0) {
              await telegramBotInstance.sendMessage(chatId, `No jobs tagged as *MAYBE* yet\\.`, { parse_mode: 'MarkdownV2' });
              return;
            }

            let responseMsg = `🔖 *Maybe Jobs (${matchingJobs.length}):*\n\n`;
            for (const j of matchingJobs) {
              responseMsg += `• *${esc(j.title)}* at *${esc(j.company)}*\n`;
              responseMsg += `  Score: *${j.score || '?'}/10* \\| Status: *${j.status || 'scored'}*\n`;
              responseMsg += `  ⚡ Apply: /apply\\_${j.id}\n`;
              responseMsg += `  🏷️ Change Tag: /tag\\_interested\\_${j.id} \\| /tag\\_not\\_interested\\_${j.id}\n\n`;
            }
            await telegramBotInstance.sendMessage(chatId, responseMsg, { parse_mode: 'MarkdownV2' });
          }
          else if (command === '/not_interested' || command === '/list_not_interested') {
            const db = await readDatabase();
            const matchingJobs = (db.jobs || [])
              .filter(j => j.tag === 'not_interested')
              .sort((a, b) => (b.score || 0) - (a.score || 0));

            if (matchingJobs.length === 0) {
              await telegramBotInstance.sendMessage(chatId, `No jobs tagged as *NOT INTERESTED* yet\\.`, { parse_mode: 'MarkdownV2' });
              return;
            }

            let responseMsg = `🔖 *Not Interested Jobs (${matchingJobs.length}):*\n\n`;
            for (const j of matchingJobs) {
              responseMsg += `• *${esc(j.title)}* at *${esc(j.company)}*\n`;
              responseMsg += `  Score: *${j.score || '?'}/10* \\| Status: *${j.status || 'scored'}*\n`;
              responseMsg += `  🏷️ Change Tag: /tag\\_interested\\_${j.id} \\| /tag\\_maybe\\_${j.id}\n\n`;
            }
            await telegramBotInstance.sendMessage(chatId, responseMsg, { parse_mode: 'MarkdownV2' });
          } 
          else if (command.startsWith('/apply_') || command === '/apply') {
            let jobId = '';
            if (command.startsWith('/apply_')) {
              jobId = command.substring(7).trim();
            } else if (msg.reply_to_message) {
              const replyText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
              const db = await readDatabase();
              const foundJob = db.jobs.find(j => 
                replyText.includes(j.company) && replyText.includes(j.title)
              );
              if (foundJob) {
                jobId = foundJob.id;
              }
            }

            if (!jobId) {
              await telegramBotInstance.sendMessage(chatId, `❌ Could not identify the job. Tap the \`/apply_job_xxxx\` link under the job card, or reply to a job card message with \`/apply\`.`);
              return;
            }

            const db = await readDatabase();
            const job = db.jobs.find(j => j.id === jobId);
            if (!job) {
              await telegramBotInstance.sendMessage(chatId, `❌ Job not found in database.`);
              return;
            }

            await telegramBotInstance.sendMessage(chatId, `⏳ Generating application assets for *${esc(job.title)}* at *${esc(job.company)}*...`, { parse_mode: 'Markdown' });

            try {
              const exporterConfig = await readConfig();
              const exporter = require('./exporter');
              
              const result = await exporter.exportJobAssets(job, exporterConfig, (msg, type) => {
                systemLog(`[Telegram /apply Command] ${msg}`, type);
              });

              if (result.success) {
                await mutateDatabase(dbMut => {
                  const targetJob = dbMut.jobs.find(j => j.id === jobId);
                  if (targetJob) {
                    targetJob.status = 'exported';
                    targetJob.folderPath = result.relativePath;
                    if (!targetJob.submissionLogs) targetJob.submissionLogs = [];
                    targetJob.submissionLogs.push(`[${new Date().toISOString()}] Assets generated via Telegram command in: ${result.relativePath}`);
                  }
                });

                // Option A: Send the full application kit (PDF resume + cover letter) as backup to Telegram
                try {
                  await notifier.sendJobApplicationKit({ ...job, status: 'exported' }, systemLog, exporterConfig, true);
                } catch (err) {
                  systemLog(`[Telegram Command] Failed to send PDF backup: ${err.message}`, 'warning');
                }

                const updatedJob = db.jobs.find(j => j.id === jobId);
                if (updatedJob) {
                  await syncJobsToGoogleSheets([updatedJob]);
                }

                let replyMsg = `📁 *Assets Exported Successfully\\!*\n\n`;
                replyMsg += `• *Folder:* \`${esc(result.relativePath)}\`\n`;
                replyMsg += `• *Company:* _${esc(job.company)}_\n`;
                replyMsg += `• *Role:* _${esc(job.title)}_\n\n`;
                replyMsg += `👉 *Apply Here:* ${esc(job.url || '')}\n\n`;
                replyMsg += `Tap to mark applied when done:\n👉 /mark\\_applied\\_${job.id}`;

                await telegramBotInstance.sendMessage(chatId, replyMsg, { parse_mode: 'MarkdownV2' });
              } else {
                await telegramBotInstance.sendMessage(chatId, `❌ *Asset Export Failed\\!* for *${esc(job.title)}* at *${esc(job.company)}*:\n\n_${esc(result.error || 'Unknown error')}_`, { parse_mode: 'MarkdownV2' });
              }
            } catch (err) {
              systemLog(`[Telegram /apply Command Error] ${err.message}`, 'error');
              await telegramBotInstance.sendMessage(chatId, `❌ Error exporting assets: ${err.message}`);
            }
          }
          else if (command.startsWith('/mark_applied_')) {
            const jobId = command.substring(14).trim();
            const db = await readDatabase();
            const job = db.jobs.find(j => j.id === jobId);
            if (!job) {
              await telegramBotInstance.sendMessage(chatId, `❌ Job not found in database.`);
              return;
            }
            await mutateDatabase(dbMut => {
              const targetJob = dbMut.jobs.find(j => j.id === jobId);
              if (targetJob) {
                targetJob.status = 'submitted';
                if (!targetJob.submissionLogs) targetJob.submissionLogs = [];
                targetJob.submissionLogs.push(`[${new Date().toISOString()}] Marked as applied via Telegram command.`);
              }
            });
            const updatedJob = db.jobs.find(j => j.id === jobId);
            if (updatedJob) {
              await syncJobsToGoogleSheets([updatedJob]);
            }
            await telegramBotInstance.sendMessage(chatId, `✅ Marked *${esc(job.title)}* at *${esc(job.company)}* as manually applied\\!`, { parse_mode: 'MarkdownV2' });
          }
          else if (command === '/applied') {
            const db = await readDatabase();
            const appliedJobs = (db.jobs || [])
              .filter(j => j.status === 'submitted')
              .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
              .slice(0, 5);
            
            if (appliedJobs.length === 0) {
              await telegramBotInstance.sendMessage(chatId, `❌ No applied jobs found in the database.`);
              return;
            }
            
            let appliedMsg = `🚀 *Last 5 Applied Jobs:*\n\n`;
            for (const j of appliedJobs) {
              appliedMsg += `• *${esc(j.title)}*\n  Company: _${esc(j.company)}_\n  Scored: *${j.score || '?'}/10* \\| Confidence: *${j.confidence || '?'}%*\n\n`;
            }
            await telegramBotInstance.sendMessage(chatId, appliedMsg, { parse_mode: 'MarkdownV2' });
          } 
          else if (command === '/run') {
            await telegramBotInstance.sendMessage(chatId, `🚀 Full job discovery scraper cycle triggered\\.`);
            runAutoDiscovery().catch(err => {
              systemLog(`[Telegram /run Command] Error: ${err.message}`, 'error');
            });
          } 
          else {
            await telegramBotInstance.sendMessage(chatId, `⚠️ Unknown command\\: *${esc(command)}*\nType \`/help\` to see all commands\\.`, { parse_mode: 'MarkdownV2' });
          }
        } catch (cmdErr) {
          systemLog(`[Telegram Command Error] Failed command ${command}: ${cmdErr.message}`, 'error');
          await telegramBotInstance.sendMessage(chatId, `❌ Error executing command: ${cmdErr.message}`);
        }
      }
    });

    let lastPollingErrorMsg = '';
    let lastPollingErrorTime = 0;

    telegramBotInstance.on('polling_error', (error) => {
      const errMsg = error.message || String(error);
      const now = Date.now();
      if (errMsg === lastPollingErrorMsg && (now - lastPollingErrorTime) < 120000) return;
      lastPollingErrorMsg = errMsg;
      lastPollingErrorTime = now;
      if (errMsg.includes('ENOTFOUND') && errMsg.includes('api.telegram.org')) {
        console.warn(`[Telegram Polling Error] Could not resolve api.telegram.org (ENOTFOUND).`);
      } else {
        console.error(`[Telegram Polling Error]: ${errMsg}`);
      }
    });

    telegramBotInstance.on('error', (error) => {
      console.error(`[Telegram Bot Error]: ${error.message}`);
    });

  } catch (err) {
    systemLog(`[Telegram Listener] Failed to initialize: ${err.message}`, 'error');
  }
}

async function processTelegramImportLink(bot, chatId, url) {
  await bot.sendMessage(chatId, `⏳ *[abhii]* Scraping job details from URL:\n${url}`, { parse_mode: 'Markdown' });
  try {
    const scraper = getScraperModule();
    const details = await scraper.scrapeJobUrl(url, (msg, type) => {
      systemLog(`[Telegram Import Scraper] ${msg}`, type);
    });

    if (!details.title || !details.description) {
      throw new Error("Could not extract title or description from job page.");
    }

    const newJob = {
      id: 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      title: details.title,
      company: details.company || 'Unknown Company',
      url: details.url,
      datePosted: new Date().toISOString().split('T')[0],
      description: details.description,
      status: 'discovered',
      score: null,
      scoreReason: null,
      analysis: null,
      tailoredResume: null,
      coverLetter: null,
      confidence: null,
      submissionLogs: [],
      timestamp: new Date().toISOString(),
      location: details.location || ''
    };

    let exists = false;
    await mutateDatabase(db => {
      const duplicate = db.jobs.find(j => (url && j.url === url) || (j.title === details.title && j.company === details.company));
      if (duplicate) {
        exists = true;
        return;
      }
      db.jobs.push(newJob);
    });

    if (exists) {
      await bot.sendMessage(chatId, `⚠️ Job *${esc(details.title)}* at *${esc(details.company)}* is already in the database.`, { parse_mode: 'Markdown' });
      return;
    }

    await bot.sendMessage(chatId, `✅ Imported *${esc(details.title)}* at *${esc(details.company)}*!\n\n🧠 Running ATS scoring...`, { parse_mode: 'Markdown' });

    const config = await readConfig();
    const llm = getLlmProvider();
    const scoreResult = await llm.scoreJob(newJob, config);
    let newStatus;
    if (scoreResult.score >= 6) newStatus = 'scored';
    else newStatus = 'skipped';

    await mutateDatabase(db => {
      const t = db.jobs.find(j => j.id === newJob.id);
      if (t) {
        t.score = scoreResult.score;
        t.scoreReason = scoreResult.reason;
        t.status = newStatus;
      }
    });

    if (newStatus === 'skipped') {
      await bot.sendMessage(chatId, `❌ *Skip (Score ${scoreResult.score}/10)*: ${esc(scoreResult.reason)}`, { parse_mode: 'Markdown' });
      return;
    }
    // Removed borderline review block

    await bot.sendMessage(chatId, `🚀 *Pass (Score ${scoreResult.score}/10)*: Running deep analysis, resume tailoring, and cover letter generation...`, { parse_mode: 'Markdown' });

    const analysis = await llm.analyzeJob(newJob, config);
    const tailoredResume = await llm.tailorResume(newJob, analysis, config);
    const coverLetter = await llm.generateCoverLetter(newJob, analysis, config);
    const coldEmail = await llm.generateColdEmail(newJob, analysis, config, newJob.poster || null);
    const confidence = await llm.calculateConfidence(newJob, analysis, tailoredResume, coverLetter, config);
    const finalStatus = 'ready';

    await mutateDatabase(db => {
      const t = db.jobs.find(j => j.id === newJob.id);
      if (t) {
        t.analysis = analysis;
        t.tailoredResume = tailoredResume;
        t.coverLetter = coverLetter;
        t.coldEmail = coldEmail;
        t.confidence = confidence;
        t.status = finalStatus;
      }
    });

    const finalJob = { ...newJob, analysis, tailoredResume, coverLetter, coldEmail, confidence, status: finalStatus };
    const alertResult = await notifier.sendJobApplicationKit(finalJob, (msg, type) => systemLog(`[Telegram Import Alert] ${msg}`, type), config, true);

    if (alertResult === 'sent') {
      await mutateDatabase(db => {
        const t = db.jobs.find(j => j.id === newJob.id);
        if (t) t.alertSent = true;
      });
    }

    await syncJobsToGoogleSheets([finalJob]);

  } catch (err) {
    systemLog(`Telegram link processing failed: ${err.message}`, 'error');
    await bot.sendMessage(chatId, `❌ Failed to process URL:\n${esc(err.message)}`, { parse_mode: 'Markdown' });
  }
}

app.listen(PORT, () => {
  systemLog(`Server running on http://localhost:${PORT}`, 'system');
  readConfig().then(config => {
    // Register the callback so Alerts-processed jobs get saved to DB & synced
    notifier.registerOnJobProcessed(async (processedJob) => {
      await mutateDatabase(db => {
        // Check if the job already exists (by URL or title+company)
        const existingIndex = db.jobs.findIndex(j =>
          (processedJob.url && j.url === processedJob.url) ||
          (j.title === processedJob.title && j.company === processedJob.company)
        );
        if (existingIndex !== -1) {
          // Update existing job with new analysis data
          const existing = db.jobs[existingIndex];
          db.jobs[existingIndex] = { ...existing, ...processedJob, id: existing.id };
          systemLog(`[Alerts] Updated existing job "${processedJob.title}" in database.`, 'info');
        } else {
          db.jobs.push(processedJob);
          systemLog(`[Alerts] Added new job "${processedJob.title}" at ${processedJob.company} to database.`, 'success');
        }
      });
      // Sync to Google Sheets
      await syncJobsToGoogleSheets([processedJob]);
    });

    // Start the Telegram Link listener bot
    initTelegramBotListener(config);

    startAutoDiscoveryScheduler();
    startDailyReportScheduler();
  }).catch(err => systemLog(`Error initializing server: ${err.message}`, 'error'));
});
