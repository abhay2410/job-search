// backend/openrouterProvider.js
// OpenRouter provider — connects to the OpenRouter unified API gateway.
// Prompts and output structures are identical to gemini.js/nvidiaProvider.js.

const https = require('https');
const path = require('path');
const fs = require('fs');
const prompts = require('./humanization_prompts');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

// ── HTTPS POST ────────────────────────────────────────────────────────────────
function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(`OpenRouter JSON parse: ${e.message} | body: ${data.slice(0, 200)}`)); }
          } else {
            const err = new Error(`OpenRouter HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
            if (res.statusCode === 429 || res.statusCode === 503) {
              err.message = `429 quota: ${err.message}`;
            }
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Generic chat call ─────────────────────────────────────────────────────────
async function chat(userPrompt, jsonMode = false, systemPrompt = null) {
  const cfg = readConfig();
  const apiKey = cfg.openrouterApiKey || '';
  const model = cfg.openrouterModel || 'meta-llama/llama-3-8b-instruct:free';

  if (!apiKey) throw new Error('OpenRouter openrouterApiKey not set in config.json');

  // When JSON mode is requested, instruct the model explicitly
  const systemMessage = systemPrompt || (jsonMode
    ? 'You are a precise JSON API. Always respond with valid JSON only. No markdown, no explanation, no code fences.'
    : 'You are a helpful expert assistant. Be accurate, concise, and professional.');

  const response = await httpsPost(
    'openrouter.ai',
    '/api/v1/chat/completions',
    { 
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/abhay2410/job-search',
      'X-Title': 'abhii Job Search Pilot'
    },
    {
      model,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      top_p: 0.7,
      max_tokens: 2048,
      stream: false
    }
  );

  return response.choices?.[0]?.message?.content ?? '';
}

// ── Safe JSON parser (strips markdown code fences if model wraps response) ────
function safeParseJson(text, fallback) {
  if (!text || typeof text !== 'string') return fallback;
  // Strip ```json ... ``` or ``` ... ``` wrappers
  let clean = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  // Extract first { ... } block
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) clean = match[0];

  // Repair: stray unquoted word(s) before a closing bracket
  // e.g.  "Adaptability to new experiences"\n   furlough],  -> "Adaptability to new experiences"],
  clean = clean.replace(/"(\s*\n\s*)[a-zA-Z0-9_\-]+(\s*)\]/g, '"$1]');

  // Repair: trailing comma before ] or }
  clean = clean.replace(/,(\s*[\]}\)])/g, '$1');

  // Repair: missing comma between consecutive quoted strings in arrays
  clean = clean.replace(/"(\s*\n\s*)"/g, '",\n"');

  try { return JSON.parse(clean); }
  catch {
    // Last-resort: brute-force extract outermost braces
    try {
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      if (s !== -1 && e > s) return JSON.parse(text.slice(s, e + 1));
    } catch { /* ignore */ }
    return fallback;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 2 – Job Scoring
// ═══════════════════════════════════════════════════════════════════════════════
async function scoreJob(job, config) {
  const gulfKeywords = (config.gulfLocations || [
    'Dubai','Abu Dhabi','UAE','Riyadh','Saudi Arabia','Doha','Qatar',
    'Muscat','Oman','Manama','Bahrain','Kuwait','GCC','Gulf','Middle East','MENA'
  ]);
  const isGulfJob = gulfKeywords.some(g =>
    (job.location || '').toLowerCase().includes(g.toLowerCase()) ||
    (job.title || '').toLowerCase().includes(g.toLowerCase()) ||
    (job.description || '').toLowerCase().includes(g.toLowerCase()) ||
    (job.company || '').toLowerCase().includes(g.toLowerCase())
  );
  const gulfBonus = isGulfJob ? (config.gulfLocationBonus || 1) : 0;

  const prompt = `
You are an AI Job Matching Assistant. Score the match between the User's Profile and the Job Description on a scale of 1 to 10.

User Profile:
- Master Resume:
${config.masterResume || 'Not provided'}

- Target Roles: ${JSON.stringify(config.targetRoles)}
- Location Preferences: ${JSON.stringify(config.locations)} (Remote Preference: ${config.remotePreference})
- Work Authorization: ${config.workAuthorization || 'Not specified'}
- Salary Floor: ${config.salaryFloor ? `$${config.salaryFloor}` : 'Not specified'}
- PRIORITY LOCATIONS (Gulf/GCC): The candidate STRONGLY PREFERS jobs in UAE, Saudi Arabia, Qatar, Oman, Bahrain, Kuwait and other Gulf countries. Give extra weight to Gulf-based roles.

Job Details:
- Title: ${job.title}
- Company: ${job.company}
- Location: ${job.location || 'Not specified'}
- URL: ${job.url}
- Job Description:
${job.description}

Rules:
1. Score 10/10: Perfect fit (user has all required skills, experience level, location/remote is aligned, target role matches).
2. Score 7-9: Strong fit (user has most critical skills, matches seniority, minor preference gaps).
3. Score 6: Borderline (user has some matching skills, but lacks key qualifications or has minor location mismatches).
4. Score 1-5: Poor fit (major skill gap, seniority mismatch, or constraint violation).
5. If the company is in the blacklisted companies (${JSON.stringify(config.blacklistCompanies)}), score it 1.
6. GULF BONUS: If this job is based in UAE, Saudi Arabia, Qatar, Oman, Bahrain, Kuwait, or any Gulf/GCC country, add +1 to the score (maximum 10). Gulf jobs are the TOP PRIORITY for this candidate.

Return ONLY valid JSON — no markdown, no explanation:
{"score": <number 1-10>, "reason": "<1-2 sentence explanation>"}
`.trim();

  const content = await chat(prompt, true);
  const result = safeParseJson(content, { score: 5, reason: 'Could not parse scoring response.' });
  let score = Math.max(1, Math.min(10, parseInt(result.score, 10) || 5));
  if (isGulfJob && score < 10) score = Math.min(10, score + gulfBonus);
  return {
    score,
    reason: `${result.reason || content.trim()}${isGulfJob ? ' [Gulf location bonus applied]' : ''}`
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 3 – Deep Job Analysis
// ═══════════════════════════════════════════════════════════════════════════════
async function analyzeJob(job, config) {
  const prompt = `
You are an expert ATS and Job Analysis AI. Analyze this job description and extract key attributes.

Job Title: ${job.title}
Job Company: ${job.company}
Job Description:
${job.description}

User Work Authorization: ${config.workAuthorization || 'Not specified'}
User Location Preferences: ${JSON.stringify(config.locations)} (Remote: ${config.remotePreference})

Extract:
1. Required skills (the must-haves).
2. Preferred skills (the nice-to-haves).
3. Company culture tone (casual, startup, enterprise, or formal).
4. Seniority level (junior, mid, senior, lead, director).
5. Keywords in the job description to optimize for.
6. Red flags (unclear responsibilities, mandatory overtime, etc.).
7. Deal breakers (e.g. requires visa sponsorship, relocation required when user wants remote, salary too low if known). Contrast this against the User's Work Authorization and Location preferences.

Return ONLY valid JSON — no markdown, no explanation:
{
  "requiredSkills": ["skill1", "skill2"],
  "preferredSkills": ["skill1", "skill2"],
  "tone": "startup|enterprise|formal|casual",
  "seniority": "junior|mid|senior|lead|director",
  "keywords": ["keyword1", "keyword2"],
  "redFlags": ["redflag1"],
  "dealBreaker": "Description of deal breaker or null"
}
`.trim();

  const content = await chat(prompt, true);
  return safeParseJson(content, {
    requiredSkills: [], preferredSkills: [], tone: 'formal',
    seniority: 'mid', keywords: [], redFlags: [], dealBreaker: null
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 4 – Resume Tailoring
// ═══════════════════════════════════════════════════════════════════════════════
async function tailorResume(job, analysis, config) {
  const profile = prompts.extractProfile(config, job.title);
  const promptData = prompts.buildResumePrompt({
    profile,
    jobDescription: job.description,
    masterResume: config.masterResume
  });

  return await chat(promptData.user, false, promptData.system);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 5 – Cover Letter
// ═══════════════════════════════════════════════════════════════════════════════
async function generateCoverLetter(job, analysis, config) {
  const profile = prompts.extractProfile(config, job.title);
  const promptData = prompts.buildCoverLetterPrompt({
    profile,
    jobDescription: job.description,
    company: job.company
  });

  return await chat(promptData.user, false, promptData.system);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 6 – Confidence Score
// ═══════════════════════════════════════════════════════════════════════════════
async function calculateConfidence(job, analysis, tailoredResume, coverLetter, config) {
  const prompt = `
You are an application quality inspector. Rate the quality of the prepared application materials for this role on a scale of 0 to 100.

Job Description:
${job.description}

Original Resume:
${config.masterResume}

Tailored Resume:
${tailoredResume}

Cover Letter:
${coverLetter}

Review Criteria:
1. Did the tailoring introduce any hallucinated skills or roles not in the original resume? (Critical safety: if YES, confidence must be < 50%).
2. Does the tailored resume naturally integrate the key required skills?
3. Is the cover letter under 250 words and well-tailored?
4. Are there any placeholders or formatting errors?

Return ONLY valid JSON — no markdown, no explanation:
{"confidence": <integer 0-100>, "feedback": "<summary of why>"}
`.trim();

  const content = await chat(prompt, true);
  const result = safeParseJson(content, { confidence: 75, feedback: '' });
  return Math.max(0, Math.min(100, parseInt(result.confidence, 10) || 75));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stage 7 – Cold Email
// ═══════════════════════════════════════════════════════════════════════════════
async function generateColdEmail(job, analysis, config, poster) {
  const profile = prompts.extractProfile(config, job.title);
  const promptData = prompts.buildColdEmailPrompt({
    profile,
    jobDescription: job.description,
    company: job.company,
    recipientName: poster ? poster.name : null
  });

  return await chat(promptData.user, false, promptData.system);
}

async function generateConnectionMessage(job, analysis, config, poster) {
  const profile = prompts.extractProfile(config, job.title);
  const promptData = prompts.buildLinkedInNotePrompt({
    profile,
    recipientName: poster ? poster.name : null,
    company: job.company
  });

  const result = await chat(promptData.user, false, promptData.system);
  return result.trim().substring(0, 300);
}

/**
 * Answer a single application form question using the candidate's resume.
 * Delegates to formAnswerer which handles caching, fast-path, and LLM fallback.
 */
async function answerFormQuestion(label, type, options, job, config) {
  const formAnswerer = require('./formAnswerer');
  return formAnswerer.answerQuestion({ label, type, options, job, config });
}

module.exports = {
  scoreJob,
  analyzeJob,
  tailorResume,
  generateCoverLetter,
  calculateConfidence,
  generateColdEmail,
  generateConnectionMessage,
  answerFormQuestion
};

