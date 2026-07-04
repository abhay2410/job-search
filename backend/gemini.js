const { GoogleGenerativeAI } = require('@google/generative-ai');
const prompts = require('./humanization_prompts');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(prompt, apiKey, jsonMode = false, modelName = "gemini-2.5-flash", systemPrompt = null) {
  let retries = 4;
  let waitTime = 16000; // Wait 16 seconds on rate limit/high demand
  
  for (let i = 0; i < retries; i++) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const modelOptions = {
        model: modelName,
        generationConfig: jsonMode ? { responseMimeType: "application/json" } : undefined
      };
      if (systemPrompt) {
        modelOptions.systemInstruction = systemPrompt;
      }
      const model = genAI.getGenerativeModel(modelOptions);
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      return text;
    } catch (err) {
      const errorMsg = err.message || '';
      const isRateLimit = errorMsg.includes('429') || errorMsg.includes('quota') || errorMsg.includes('Quota');
      const isUnavailable = errorMsg.includes('503') || errorMsg.includes('Service Unavailable') || errorMsg.includes('demand');
      
      if ((isRateLimit || isUnavailable) && i < retries - 1) {
        console.log(`[API Rate-Limit / High Demand] Waiting ${waitTime / 1000} seconds before retrying (Attempt ${i + 1}/${retries})...`);
        await delay(waitTime);
        waitTime *= 1.5; // Exponential backoff
        continue;
      }
      console.error('Gemini API call failed:', err);
      throw err;
    }
  }
}

function cleanAndParseJson(text, fallback) {
  if (!text || typeof text !== 'string') return fallback;
  try {
    // Strip markdown fences
    let clean = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    // Extract the first JSON object structure
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    clean = match[0];

    // Repair: stray unquoted word(s) AFTER a closing quote, before ]
    // e.g.  "Adaptability to new experiences"\n   furlough],  -> "Adaptability to new experiences"],
    clean = clean.replace(/"(\s*\n\s*)[a-zA-Z0-9_\-]+(\s*)\]/g, '"$1]');

    // Repair: trailing comma before ] or }
    clean = clean.replace(/,(\s*[\]}\)])/g, '$1');

    // Repair: missing comma between consecutive quoted strings in arrays
    clean = clean.replace(/"(\s*\n\s*)"/g, '",\n"');

    return JSON.parse(clean);
  } catch (err) {
    try {
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      if (s !== -1 && e > s) return JSON.parse(text.slice(s, e + 1));
    } catch { /* ignore */ }
    return fallback;
  }
}

// Stage 2 - Job Scoring (1-10)
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

Return your response in raw JSON format matching this schema:
{
  "score": number, // 1 to 10
  "reason": "String explaining the rating in 1-2 sentences"
}
`;

  const responseText = await callGemini(prompt, config.geminiApiKey, true);
  try {
    const parsed = cleanAndParseJson(responseText, { score: 5, reason: 'Failed to parse AI scoring output.' });
    let score = Math.max(1, Math.min(10, parseInt(parsed.score, 10) || 5));
    // Apply Gulf bonus post-parse as a safety net
    if (isGulfJob && score < 10) score = Math.min(10, score + gulfBonus);
    return {
      score,
      reason: `${parsed.reason || ''}${isGulfJob ? ' [Gulf location bonus applied]' : ''}`
    };
  } catch (err) {
    console.error('Failed to parse Gemini score response:', responseText);
    return { score: 5, reason: 'Failed to parse AI scoring output.' };
  }
}

// Stage 3 - Deep Job Analysis
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

Return your response in raw JSON format matching this schema:
{
  "requiredSkills": ["skill1", "skill2", ...],
  "preferredSkills": ["skill1", "skill2", ...],
  "tone": "startup" | "enterprise" | "formal" | "casual",
  "seniority": "junior" | "mid" | "senior" | "lead" | "director",
  "keywords": ["keyword1", "keyword2", ...],
  "redFlags": ["redflag1", ...],
  "dealBreaker": "Description of any deal breaker (e.g., 'Requires US Work Authorization, user does not have it') or null if none"
}
`;

  const responseText = await callGemini(prompt, config.geminiApiKey, true);
  const fallback = {
    requiredSkills: [],
    preferredSkills: [],
    tone: 'formal',
    seniority: 'mid',
    keywords: [],
    redFlags: [],
    dealBreaker: null
  };
  try {
    const result = cleanAndParseJson(responseText, fallback);
    if (!result || !result.requiredSkills) return fallback;
    return result;
  } catch (err) {
    console.error('Failed to parse Gemini analysis response:', responseText);
    return fallback;
  }
}

// Stage 4 - Resume Tailoring
async function tailorResume(job, analysis, config) {
  const profile = prompts.extractProfile(config, job.title);
  const promptData = prompts.buildResumePrompt({
    profile,
    jobDescription: job.description,
    masterResume: config.masterResume
  });

  return await callGemini(promptData.user, config.geminiApiKey, false, "gemini-2.5-flash", promptData.system);
}

// Stage 5 - Cover Letter Generation
async function generateCoverLetter(job, analysis, config) {
  const profile = prompts.extractProfile(config, job.title);
  const promptData = prompts.buildCoverLetterPrompt({
    profile,
    jobDescription: job.description,
    company: job.company
  });

  return await callGemini(promptData.user, config.geminiApiKey, false, "gemini-2.5-flash", promptData.system);
}

// Validation & Confidence Score (Stage 6 prerequisite)
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

Return your response in raw JSON format matching this schema:
{
  "confidence": number, // integer between 0 and 100
  "feedback": "String summarizing why this score was given, highlighting any issues"
}
`;

  const responseText = await callGemini(prompt, config.geminiApiKey, true);
  try {
    const result = cleanAndParseJson(responseText, { confidence: 75 });
    return result.confidence || 75;
  } catch (err) {
    console.error('Failed to parse Gemini confidence response:', responseText);
    return 75;
  }
}

// Stage 5.5 - Cold Email Generation
async function generateColdEmail(job, analysis, config, poster) {
  const profile = prompts.extractProfile(config, job.title);
  const promptData = prompts.buildColdEmailPrompt({
    profile,
    jobDescription: job.description,
    company: job.company,
    recipientName: poster ? poster.name : null
  });

  return await callGemini(promptData.user, config.geminiApiKey, false, "gemini-2.5-flash", promptData.system);
}

async function generateConnectionMessage(job, analysis, config, poster) {
  const profile = prompts.extractProfile(config, job.title);
  const promptData = prompts.buildLinkedInNotePrompt({
    profile,
    recipientName: poster ? poster.name : null,
    company: job.company
  });

  return (await callGemini(promptData.user, config.geminiApiKey, false, "gemini-2.5-flash", promptData.system)).trim().substring(0, 300);
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
