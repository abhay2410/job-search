const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const notifier = require('./notifier');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DATABASE_PATH = path.join(__dirname, '..', 'database.json');

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

async function readDatabaseInternal() {
  try {
    if (!fs.existsSync(DATABASE_PATH)) {
      return { jobs: [] };
    }
    const data = await fs.promises.readFile(DATABASE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database:', err);
    return { jobs: [] };
  }
}

async function writeDatabaseInternal(db) {
  try {
    await fs.promises.writeFile(DATABASE_PATH, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing database:', err);
    return false;
  }
}

async function readDatabase() {
  const release = await dbMutex.acquire();
  try {
    return await readDatabaseInternal();
  } finally {
    release();
  }
}

async function writeDatabase(db) {
  const release = await dbMutex.acquire();
  try {
    return await writeDatabaseInternal(db);
  } finally {
    release();
  }
}

// Transaction wrapper for atomic read-mutate-write operations
async function mutateDatabase(mutationFn) {
  const release = await dbMutex.acquire();
  try {
    const db = await readDatabaseInternal();
    const result = await mutationFn(db);
    await writeDatabaseInternal(db);
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
            
            // Auto filter or flag
            if (result.score >= 7) {
              targetJob.status = 'scored';
              systemLog(`Job passed scoring! Score: ${result.score}/10. Reason: ${result.reason}`, 'success');
            } else if (result.score === 6) {
              targetJob.status = 'review';
              systemLog(`Job scored borderline (6/10). Added to Human Review Queue. Reason: ${result.reason}`, 'warning');
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

    let status = 'review';
    // Transition status to ready if no review flagged, else review
    if (confidence >= 80 && !analysis.dealBreaker) {
      status = 'ready';
      systemLog(`Job analysis ready! Confidence score: ${confidence}%. Ready to apply.`, 'success');
    } else {
      systemLog(`Job analysis complete but flagged for human review (Confidence: ${confidence}%, Dealbreaker: ${analysis.dealBreaker || 'None'}).`, 'warning');
    }

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
// STAGE 6 - Application Submission (Playwright applier)
app.post('/api/jobs/apply', async (req, res) => {
  const { id, force = false } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing job id' });
  }

  const db = await readDatabase();
  const job = db.jobs.find(j => j.id === id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Rate limiting check: Max 30 submissions per day
  const today = new Date().toISOString().split('T')[0];
  const submittedToday = db.jobs.filter(j => 
    j.status === 'submitted' && 
    j.submissionLogs && 
    j.submissionLogs.some(log => log.includes(today))
  ).length;

  if (submittedToday >= 30 && !force) {
    systemLog('Rate limit reached: Max 30 submissions/day. Application queued.', 'warning');
    return res.status(400).json({ error: 'Daily application rate limit reached (30/day).' });
  }

  res.json({ success: true, message: 'Application process launched' });

  try {
    const config = await readConfig();
    const applier = getApplierModule();
    
    systemLog(`Launching Playwright browser to apply for "${job.title}" at ${job.company}...`, 'info');
    
    const result = await applier.applyToJob(job, config, systemLog);
    
    await mutateDatabase(dbMut => {
      const targetJob = dbMut.jobs.find(j => j.id === id);
      if (targetJob) {
        if (!targetJob.submissionLogs) targetJob.submissionLogs = [];
        if (result.needReview) {
          targetJob.status = 'review';
          targetJob.submissionLogs.push(`[${new Date().toISOString()}] Form requires manual input: ${result.message}`);
          systemLog(`Application paused: manual review required: ${result.message}`, 'warning');
          notifier.sendJobApplicationKit(targetJob, systemLog, config);
        } else if (result.success) {
          targetJob.status = 'submitted';
          targetJob.submissionLogs.push(`[${new Date().toISOString()}] Successfully applied via automated browser.`);
          systemLog(`Successfully applied to "${job.title}" at ${job.company}!`, 'success');
        } else {
          targetJob.submissionLogs.push(`[${new Date().toISOString()}] Application failed: ${result.message}`);
          systemLog(`Failed to apply to "${job.title}" at ${job.company}: ${result.message}`, 'error');
        }
      }
    });
    
  } catch (err) {
    systemLog(`Error during application execution: ${err.message}`, 'error');
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

// Sandbox Endpoints for Testing
app.get('/sandbox', (req, res) => {
  res.sendFile(path.join(__dirname, 'sandbox.html'));
});

app.get('/sandbox-success', (req, res) => {
  res.send('<h1>Application Submitted Successfully (Sandbox)!</h1><p>Query parameters: ' + JSON.stringify(req.query) + '</p>');
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
    
    for (let i = 0; i < selectedCombos.length; i++) {
      const { role, loc } = selectedCombos[i];
      systemLog(`[Auto-Discovery] Running scraper for Keyword: "${role}", Location: "${loc}" (Combo ${i+1}/${selectedCombos.length})...`, 'info');
      try {
        const scraper = getScraperModule();
        const jobs = await scraper.scrapeJobs(role, loc, config, systemLog);
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
          if (result.score >= 7) {
            newStatus = 'scored';
            systemLog(`[Auto-Discovery] Job passed scoring! Score: ${result.score}/10. Reason: ${result.reason}`, 'success');
          } else if (result.score === 6) {
            newStatus = 'review';
            systemLog(`[Auto-Discovery] Job scored borderline (6/10). Added to Human Review Queue. Reason: ${result.reason}`, 'warning');
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

          const newStatus = (confidence >= 80 && !analysis.dealBreaker) ? 'ready' : 'review';
          if (newStatus === 'ready') {
            systemLog(`[Auto-Discovery] Job analysis ready! Confidence score: ${confidence}%. Ready to apply.`, 'success');
          } else {
            systemLog(`[Auto-Discovery] Job analysis complete but flagged for human review (Confidence: ${confidence}%, Dealbreaker: ${analysis.dealBreaker || 'None'}).`, 'warning');
          }

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
    
    // Stage 6 - Auto-Apply to 'ready' jobs
    const applyConfig = await readConfig();
    if (applyConfig.autoApplyEnabled !== false) {
      const applyDb = await readDatabase();
      const readyJobs = applyDb.jobs.filter(j => j.status === 'ready');
      const maxApply = applyConfig.maxJobsAppliedPerRun || 5;

      const today = new Date().toISOString().split('T')[0];
      const submittedToday = applyDb.jobs.filter(j =>
        j.status === 'submitted' &&
        j.submissionLogs &&
        j.submissionLogs.some(log => log.includes(today))
      ).length;

      const remaining = Math.max(0, 30 - submittedToday);
      const toApply = readyJobs.slice(0, Math.min(maxApply, remaining));

      if (readyJobs.length === 0) {
        systemLog('[Auto-Apply] No jobs in "ready" state to apply to.', 'info');
      } else if (remaining === 0) {
        systemLog('[Auto-Apply] Daily application limit reached (30/day). Will resume tomorrow.', 'warning');
      } else {
        systemLog(`[Auto-Apply] ${readyJobs.length} job(s) ready. Applying to ${toApply.length} this cycle (Daily quota: ${submittedToday}/30 used, ${remaining} remaining)...`, 'info');
        const applier = getApplierModule();

        for (let i = 0; i < toApply.length; i++) {
          const job = toApply[i];
          systemLog(`[Auto-Apply] Applying to job ${i + 1}/${toApply.length}: "${job.title}" at ${job.company}...`, 'info');
          try {
            const result = await applier.applyToJob(job, applyConfig, systemLog);

            await mutateDatabase(db => {
              const freshJob = db.jobs.find(j => j.id === job.id);
              if (!freshJob) return;
              freshJob.submissionLogs = freshJob.submissionLogs || [];
              if (result.success && !result.needReview) {
                freshJob.status = 'submitted';
                freshJob.submissionLogs.push(`[${new Date().toISOString()}] Auto-applied via automated browser.`);
                systemLog(`[Auto-Apply] ✅ Successfully applied to "${job.title}" at ${job.company}!`, 'success');
                jobsToSyncMap.set(freshJob.id, { ...freshJob });
              } else if (result.needReview) {
                freshJob.status = 'review';
                freshJob.submissionLogs.push(`[${new Date().toISOString()}] Auto-apply paused: ${result.message}`);
                systemLog(`[Auto-Apply] ⚠️ Application for "${job.title}" requires manual review: ${result.message}`, 'warning');
                jobsToSyncMap.set(freshJob.id, { ...freshJob });
                notifier.sendJobApplicationKit(freshJob, systemLog, applyConfig);
              } else {
                freshJob.submissionLogs.push(`[${new Date().toISOString()}] Auto-apply failed: ${result.message}`);
                systemLog(`[Auto-Apply] ❌ Failed to apply to "${job.title}": ${result.message}`, 'error');
              }
            });
          } catch (err) {
            systemLog(`[Auto-Apply] Error applying to "${job.title}" at ${job.company}: ${err.message}`, 'error');
          }

          if (i < toApply.length - 1) {
            systemLog(`[Auto-Apply] Waiting 30 seconds before next application...`, 'info');
            await delay(30000);
          }
        }
      }
    } else {
      systemLog('[Auto-Apply] Auto-apply is disabled in configuration. Skipping.', 'info');
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
        if (result.score >= 7) { newStatus = 'scored'; systemLog(`[scoreNow] ✅ ${result.score}/10 — ${job.title}`, 'success'); }
        else if (result.score === 6) { newStatus = 'review'; systemLog(`[scoreNow] ⚠️ 6/10 borderline — ${job.title}`, 'warning'); }
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
        const newStatus = (confidence >= 80 && !analysis.dealBreaker) ? 'ready' : 'review';
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

        startAutoDiscoveryScheduler();
  }).catch(err => systemLog(`Error initializing server: ${err.message}`, 'error'));
});
