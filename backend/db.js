const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new Database(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT,
    company TEXT,
    url TEXT UNIQUE,
    description TEXT,
    location TEXT,
    status TEXT,
    score INTEGER,
    scoreReason TEXT,
    tailoredResume TEXT,
    coverLetter TEXT,
    timestamp TEXT,
    careerSiteUrl TEXT,
    hrEmail TEXT,
    telegramSent INTEGER,
    alertSent INTEGER,
    posterName TEXT,
    posterTitle TEXT,
    posterUrl TEXT,
    submissionLogs TEXT
  )
`);

/**
 * Convert a database row to a JS job object
 */
function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    url: row.url,
    description: row.description,
    location: row.location,
    status: row.status,
    score: row.score,
    scoreReason: row.scoreReason,
    tailoredResume: row.tailoredResume,
    coverLetter: row.coverLetter,
    timestamp: row.timestamp,
    careerSiteUrl: row.careerSiteUrl,
    hrEmail: row.hrEmail,
    telegramSent: Boolean(row.telegramSent),
    alertSent: Boolean(row.alertSent),
    poster: {
      name: row.posterName || '',
      title: row.posterTitle || '',
      url: row.posterUrl || ''
    },
    submissionLogs: row.submissionLogs ? JSON.parse(row.submissionLogs) : []
  };
}

/**
 * Get all jobs
 */
function getAllJobs() {
  const rows = db.prepare('SELECT * FROM jobs').all();
  return rows.map(rowToJob);
}

/**
 * Get a single job by ID
 */
function getJobById(id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return rowToJob(row);
}

/**
 * Check if a URL already exists
 */
function urlExists(url) {
  const row = db.prepare('SELECT 1 FROM jobs WHERE url = ?').get(url);
  return !!row;
}

/**
 * Insert or update a job
 */
function upsertJob(job) {
  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, title, company, url, description, location, status,
      score, scoreReason, tailoredResume, coverLetter, timestamp,
      careerSiteUrl, hrEmail, telegramSent, alertSent,
      posterName, posterTitle, posterUrl, submissionLogs
    ) VALUES (
      @id, @title, @company, @url, @description, @location, @status,
      @score, @scoreReason, @tailoredResume, @coverLetter, @timestamp,
      @careerSiteUrl, @hrEmail, @telegramSent, @alertSent,
      @posterName, @posterTitle, @posterUrl, @submissionLogs
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      company = excluded.company,
      url = excluded.url,
      description = excluded.description,
      location = excluded.location,
      status = excluded.status,
      score = excluded.score,
      scoreReason = excluded.scoreReason,
      tailoredResume = excluded.tailoredResume,
      coverLetter = excluded.coverLetter,
      timestamp = excluded.timestamp,
      careerSiteUrl = excluded.careerSiteUrl,
      hrEmail = excluded.hrEmail,
      telegramSent = excluded.telegramSent,
      alertSent = excluded.alertSent,
      posterName = excluded.posterName,
      posterTitle = excluded.posterTitle,
      posterUrl = excluded.posterUrl,
      submissionLogs = excluded.submissionLogs
  `);

  stmt.run({
    id: job.id,
    title: job.title || '',
    company: job.company || '',
    url: job.url || '',
    description: job.description || '',
    location: job.location || '',
    status: job.status || 'new',
    score: job.score || 0,
    scoreReason: job.scoreReason || '',
    tailoredResume: job.tailoredResume || '',
    coverLetter: job.coverLetter || '',
    timestamp: job.timestamp || new Date().toISOString(),
    careerSiteUrl: job.careerSiteUrl || '',
    hrEmail: job.hrEmail || '',
    telegramSent: job.telegramSent ? 1 : 0,
    alertSent: job.alertSent ? 1 : 0,
    posterName: job.poster?.name || '',
    posterTitle: job.poster?.title || '',
    posterUrl: job.poster?.url || '',
    submissionLogs: JSON.stringify(job.submissionLogs || [])
  });
}

/**
 * Delete jobs older than a given date, but keep processed ones
 */
function deleteOldJobs(daysOld = 14) {
  const dateLimit = new Date();
  dateLimit.setDate(dateLimit.getDate() - daysOld);
  
  const stmt = db.prepare(`
    DELETE FROM jobs 
    WHERE timestamp < ? AND status IN ('new', 'skipped', 'discovered')
  `);
  return stmt.run(dateLimit.toISOString());
}

/**
 * Get jobs pending processing
 */
function getPendingJobs(limit = 15) {
  const rows = db.prepare(`
    SELECT * FROM jobs 
    WHERE status = 'new' 
    ORDER BY timestamp DESC 
    LIMIT ?
  `).all(limit);
  return rows.map(rowToJob);
}

module.exports = {
  getAllJobs,
  getJobById,
  urlExists,
  upsertJob,
  deleteOldJobs,
  getPendingJobs,
  db
};
