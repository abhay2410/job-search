/**
 * formAnswerer.js
 *
 * LLM-powered form question answerer for the auto-apply pipeline.
 *
 * Strategy (in priority order):
 *  1. Q&A cache  — check db.savedAnswers first (zero API cost)
 *  2. Fast-path  — deterministic keyword rules for common fields
 *  3. LLM call   — Gemini (with fallback chain) generates a grounded answer
 *                  from the candidate's resume + job description.
 *
 * All answers are written back to db.savedAnswers so every future
 * application that hits the same question gets a free cache hit.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function readDb() {
  const sqliteDb = require('./db');
  const jobs = sqliteDb.getAllJobs();
  let savedAnswers = {};
  const answersPath = path.join(__dirname, '..', 'answers.json');
  try {
    if (fs.existsSync(answersPath)) {
      savedAnswers = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
    }
  } catch (err) {}
  return { jobs, savedAnswers };
}

function writeDb(db) {
  const sqliteDb = require('./db');
  try {
    for (const job of (db.jobs || [])) {
      sqliteDb.upsertJob(job);
    }
    const answersPath = path.join(__dirname, '..', 'answers.json');
    fs.writeFileSync(answersPath, JSON.stringify(db.savedAnswers || {}, null, 2));
  } catch (e) {
    console.error('[Form Answerer] Failed to write DB:', e.message);
  }
}

/** Normalize a question label for use as a cache key */
function normalizeKey(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Save an answer to the persistent Q&A bank */
async function saveAnswer(normKey, answer) {
  if (!normKey || !answer) return;
  try {
    const db = readDb();
    db.savedAnswers = db.savedAnswers || {};
    db.savedAnswers[normKey] = answer;
    writeDb(db);
  } catch (e) {
    console.error('[Form Answerer] saveAnswer error:', e.message);
  }
}

// ── Fast-path (no LLM needed) ─────────────────────────────────────────────────

/**
 * Deterministic answers for well-known field types.
 * Returns a string answer, or null if the pattern is not recognised.
 */
function tryFastAnswer(label, type, options, config) {
  const l = (label || '').toLowerCase();
  const cfg = config || readConfig();

  // ── Text / number fields ──────────────────────────────────────────────────
  if (type === 'text' || type === 'number' || type === 'tel' || type === 'email' || type === 'url') {
    if (l.includes('first name') || (l.includes('first') && l.includes('name'))) {
      const parts = (cfg.masterResume || '').split('\n')[0].trim().split(/\s+/);
      return parts[0] || 'Abhay';
    }
    if (l.includes('last name') || (l.includes('last') && l.includes('name'))) {
      const parts = (cfg.masterResume || '').split('\n')[0].trim().split(/\s+/);
      return parts.slice(1).join(' ') || 'Ramesh';
    }
    if (l.includes('full name') || l === 'name') {
      return (cfg.masterResume || '').split('\n')[0].trim() || 'Abhay Ramesh';
    }
    if (l.includes('email')) {
      const m = (cfg.masterResume || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      return m ? m[0] : (cfg.smtpUser || '');
    }
    if (l.includes('phone') || l.includes('mobile') || type === 'tel') {
      const m = (cfg.masterResume || '').match(/(\+?\d[\d\s\-().]{7,}\d)/);
      return m ? m[0] : '';
    }
    if (l.includes('linkedin')) {
      const m = (cfg.masterResume || '').match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
      return m ? `https://${m[0]}` : '';
    }
    if (l.includes('github')) {
      const m = (cfg.masterResume || '').match(/github\.com\/[a-zA-Z0-9_-]+/i);
      return m ? `https://${m[0]}` : '';
    }
    if (l.includes('portfolio') || l.includes('website') || l.includes('personal site') || type === 'url') {
      const li = (cfg.masterResume || '').match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
      return li ? `https://${li[0]}` : '';
    }
    if (l.includes('salary') || l.includes('compensation') || l.includes('expected ctc') || l.includes('expected salary')) {
      return cfg.expectedSalary || '5000';
    }
    if ((l.includes('year') || l.includes('years')) && l.includes('experience')) {
      return cfg.yearsExperience || '1';
    }
    if (l.includes('notice') || l.includes('joining') || l.includes('availability')) {
      return cfg.noticePeriod || 'Immediately';
    }
    if (l.includes('current company') || l.includes('current employer') || l.includes('present company')) {
      return cfg.currentCompany || 'Not currently employed (Available immediately)';
    }
    if (l.includes('city') || l.includes('location') || l.includes('current location')) {
      return cfg.defaultCity || 'Dubai';
    }
    if (l.includes('headline') || l.includes('professional headline')) {
      return cfg.headline || 'Embedded Engineer | IoT | Technical Support';
    }
  }

  // ── Select dropdowns ──────────────────────────────────────────────────────
  if (type === 'select' && options && options.length > 0) {
    const opts = options.map(o => ({ text: o, lower: o.toLowerCase() }));

    if (l.includes('experience') || l.includes('years of exp')) {
      const yrs = parseInt(cfg.yearsExperience || '1', 10);
      // Try to find the option that includes our experience number
      const exact = opts.find(o => o.lower.includes(String(yrs)));
      if (exact) return exact.text;
      // Pick the first non-placeholder option
      const first = opts.find(o => o.lower !== 'select an option' && o.lower !== '' && o.text !== '');
      return first ? first.text : opts[0].text;
    }
    if (l.includes('education') || l.includes('degree') || l.includes('qualification')) {
      const deg = opts.find(o => o.lower.includes('bachelor') || o.lower.includes("bachelor's"));
      return deg ? deg.text : (opts.length > 1 ? opts[1].text : opts[0].text);
    }
    if (l.includes('country') || l.includes('nationality')) {
      const ind = opts.find(o => o.lower.includes('india') || o.lower.includes('indian'));
      return ind ? ind.text : (opts.length > 1 ? opts[1].text : opts[0].text);
    }
    if (l.includes('currency')) {
      const aed = opts.find(o => o.lower.includes('aed') || o.lower.includes('dirham'));
      const usd = opts.find(o => o.lower.includes('usd') || o.lower.includes('dollar'));
      return (aed || usd || opts[0]).text;
    }
  }

  // ── Radio buttons ─────────────────────────────────────────────────────────
  if (type === 'radio' && options && options.length > 0) {
    const opts = options.map(o => ({ text: o, lower: o.toLowerCase() }));

    if (l.includes('authoriz') || l.includes('legally') || l.includes('right to work') || l.includes('eligible to work')) {
      const yes = opts.find(o => o.lower.includes('yes') || o.lower === 'y');
      return yes ? yes.text : opts[0].text;
    }
    if (l.includes('sponsor') || l.includes('visa sponsor') || l.includes('require sponsorship')) {
      const no = opts.find(o => o.lower.includes('no') || o.lower === 'n');
      return no ? no.text : opts[opts.length - 1].text;
    }
    if (l.includes('relocat') || l.includes('commut') || l.includes('willing to travel')) {
      const yes = opts.find(o => o.lower.includes('yes') || o.lower === 'y');
      return yes ? yes.text : opts[0].text;
    }
    if (l.includes('gender')) return null; // Let LLM handle EEO
    if (l.includes('veteran') || l.includes('disability') || l.includes('race') || l.includes('ethnicity')) return null;
  }

  return null; // Not handled by fast-path
}

// ── LLM call ──────────────────────────────────────────────────────────────────

/**
 * Build the LLM prompt for answering a single form question.
 */
function buildPrompt(label, type, options, job, config) {
  const resume = (config.masterResume || '').substring(0, 3000); // Trim to stay within token limits
  const jobSnippet = (job.description || '').substring(0, 1500);

  let instruction = '';

  if (type === 'select' && options && options.length > 0) {
    instruction = `You must pick EXACTLY ONE option from this list that best matches the candidate's profile:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nReturn ONLY the exact text of the chosen option. No quotes, no explanation.`;
  } else if (type === 'radio' && options && options.length > 0) {
    instruction = `You must pick EXACTLY ONE option from this list:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\nReturn ONLY the exact text of the chosen option. No quotes, no explanation.`;
  } else if (type === 'textarea') {
    instruction = `Write a factual, concise answer in 2–4 sentences. Only use facts present in the candidate's resume. Do NOT use buzzwords like "passionate", "leverage", "synergy", "delve", "innovative". Write in first person, plain English.`;
  } else {
    instruction = `Write a factual, direct answer in 1–2 sentences (or just a number/phrase if appropriate). Only use facts from the resume. No buzzwords.`;
  }

  return `You are helping a job applicant fill out an application form.

CANDIDATE RESUME:
${resume}

JOB TITLE: ${job.title || 'Unknown'}
COMPANY: ${job.company || 'Unknown'}
JOB DESCRIPTION (excerpt):
${jobSnippet}

APPLICATION QUESTION: "${label}"

INSTRUCTIONS: ${instruction}`;
}

/**
 * Call the LLM (Gemini primary, with fallback to NVIDIA/OpenRouter via llmProvider).
 * We call Gemini directly here to avoid circular dependency — llmProvider requires
 * provider modules, but formAnswerer is also required by applier.
 */
async function callLlm(label, type, options, job, config) {
  // Try Gemini first (primary)
  if (config.geminiApiKey) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(config.geminiApiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const prompt = buildPrompt(label, type, options, job, config);
      const result = await model.generateContent(prompt);
      const text = (result.response.text() || '').trim();
      if (text) return text;
    } catch (e) {
      console.error('[Form Answerer] Gemini failed:', e.message);
    }
  }

  // Fallback: NVIDIA
  try {
    const nim = config.nvidiaNim || {};
    if (nim.apiKey) {
      const https = require('https');
      const prompt = buildPrompt(label, type, options, job, config);
      const payload = JSON.stringify({
        model: nim.model || 'meta/llama-3.1-8b-instruct',
        messages: [
          { role: 'system', content: 'You are a precise job application assistant. Answer questions factually and concisely based only on the provided resume.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 256,
        stream: false
      });

      const text = await new Promise((resolve, reject) => {
        const req = https.request(
          { hostname: 'integrate.api.nvidia.com', path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${nim.apiKey}` } },
          res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
              try { resolve(JSON.parse(d).choices?.[0]?.message?.content || ''); }
              catch { resolve(''); }
            });
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      if (text.trim()) return text.trim();
    }
  } catch (e) {
    console.error('[Form Answerer] NVIDIA fallback failed:', e.message);
  }

  // Fallback: OpenRouter
  try {
    const orKey = config.openrouterApiKey;
    const orModel = config.openrouterModel || 'meta-llama/llama-3-8b-instruct:free';
    if (orKey) {
      const https = require('https');
      const prompt = buildPrompt(label, type, options, job, config);
      const payload = JSON.stringify({
        model: orModel,
        messages: [
          { role: 'system', content: 'You are a precise job application assistant. Answer questions factually based only on the provided resume.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 256
      });

      const text = await new Promise((resolve, reject) => {
        const req = https.request(
          { hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
              Authorization: `Bearer ${orKey}`, 'HTTP-Referer': 'https://github.com/abhay2410/job-search', 'X-Title': 'abhii Job Search' } },
          res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
              try { resolve(JSON.parse(d).choices?.[0]?.message?.content || ''); }
              catch { resolve(''); }
            });
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      if (text.trim()) return text.trim();
    }
  } catch (e) {
    console.error('[Form Answerer] OpenRouter fallback failed:', e.message);
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Answer a single application form question.
 *
 * @param {object} params
 * @param {string}   params.label    - The question/field label text
 * @param {string}   params.type     - 'text'|'textarea'|'select'|'radio'|'number'|'tel'|'email'|'url'
 * @param {string[]} params.options  - Available options (for select/radio)
 * @param {object}   params.job      - Job object {title, company, description}
 * @param {object}   params.config   - Config object (or null to read from disk)
 * @param {function} params.logFn    - Optional log function
 * @returns {Promise<string|null>}   - The answer string, or null if unable to answer
 */
async function answerQuestion({ label, type, options = [], job = {}, config = null, logFn = null }) {
  const cfg = config || readConfig();
  const log = logFn || ((msg, lvl) => console.log(`[Form Answerer][${lvl || 'info'}] ${msg}`));

  const normKey = normalizeKey(label);

  // 1. Cache check
  const db = readDb();
  db.savedAnswers = db.savedAnswers || {};
  if (normKey && db.savedAnswers[normKey]) {
    log(`[Q&A Cache] Hit: "${label}" → "${db.savedAnswers[normKey]}"`, 'success');
    return db.savedAnswers[normKey];
  }

  // 2. Fast-path (deterministic keyword rules)
  const fast = tryFastAnswer(label, type, options, cfg);
  if (fast !== null) {
    log(`[Form Answerer] Fast-path: "${label}" → "${fast}"`, 'info');
    await saveAnswer(normKey, fast);
    return fast;
  }

  // 3. LLM call
  log(`[Form Answerer] Asking LLM: "${label}" (type=${type}, options=[${options.slice(0, 3).join(', ')}${options.length > 3 ? '...' : ''}])`, 'info');
  try {
    const llmAnswer = await callLlm(label, type, options, job, cfg);
    if (llmAnswer) {
      // Validate: for select/radio, make sure answer matches one of the options
      let finalAnswer = llmAnswer.trim();
      if ((type === 'select' || type === 'radio') && options.length > 0) {
        const matched = options.find(o =>
          o.toLowerCase() === finalAnswer.toLowerCase() ||
          o.toLowerCase().includes(finalAnswer.toLowerCase()) ||
          finalAnswer.toLowerCase().includes(o.toLowerCase())
        );
        if (matched) {
          finalAnswer = matched;
        } else {
          // LLM gave text that doesn't match any option — use index if it returned a number
          const idx = parseInt(finalAnswer, 10);
          if (!isNaN(idx) && idx >= 1 && idx <= options.length) {
            finalAnswer = options[idx - 1];
          } else {
            // Default to first non-placeholder option
            finalAnswer = options.find(o => o.toLowerCase() !== 'select an option' && o !== '') || options[0];
            log(`[Form Answerer] LLM answer didn't match options, using default: "${finalAnswer}"`, 'warning');
          }
        }
      }

      log(`[Form Answerer] LLM answered: "${label}" → "${String(finalAnswer).substring(0, 80)}${finalAnswer.length > 80 ? '...' : ''}"`, 'success');
      await saveAnswer(normKey, finalAnswer);
      return finalAnswer;
    }
  } catch (e) {
    log(`[Form Answerer] LLM error: ${e.message}`, 'error');
  }

  // 4. No answer found
  log(`[Form Answerer] Could not answer: "${label}". Leaving blank.`, 'warning');
  return null;
}

module.exports = { answerQuestion, normalizeKey };
