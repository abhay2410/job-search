const { GoogleGenerativeAI } = require('@google/generative-ai');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(prompt, apiKey, jsonMode = false, modelName = "gemini-2.5-flash") {
  let retries = 4;
  let waitTime = 16000; // Wait 16 seconds on rate limit/high demand
  
  for (let i = 0; i < retries; i++) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: jsonMode ? { responseMimeType: "application/json" } : undefined
      });
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
    const parsed = JSON.parse(responseText.trim());
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
  try {
    return JSON.parse(responseText.trim());
  } catch (err) {
    console.error('Failed to parse Gemini analysis response:', responseText);
    return {
      requiredSkills: [],
      preferredSkills: [],
      tone: 'formal',
      seniority: 'mid',
      keywords: [],
      redFlags: [],
      dealBreaker: null
    };
  }
}

// Stage 4 - Resume Tailoring
async function tailorResume(job, analysis, config) {
  const prompt = `
You are an expert Resume Writer and ATS Optimizer. Rewrite the user's Master Resume specifically for this job description.

Job Title: ${job.title}
Company: ${job.company}
Extracted Keywords/Skills: ${JSON.stringify(analysis.keywords.concat(analysis.requiredSkills))}

Master Resume:
${config.masterResume}

Strict Rules:
1. DO NOT fabricate or hallucinate any experience, roles, companies, projects, credentials, or skills. You may only highlight, expand on, or rephrase the USER'S ACTUAL experience.
2. Front-load the most relevant experience and accomplishments in the work history section. Reorganize bullet points within each job so the ones matching the job description appear first.
3. Incorporate the extracted keywords and skills naturally into bullet points and summary.
4. Keep the output clean, professional, and formatted in clear Markdown.
5. Ensure the original details (contact info, degree, dates, company names) remain unchanged.

Output ONLY the tailored resume in Markdown. Do not include any intro, outro, or explanation.
`;

  return await callGemini(prompt, config.geminiApiKey, false);
}

// Stage 5 - Cover Letter Generation
async function generateCoverLetter(job, analysis, config) {
  const prompt = `
You are an expert Career Coach. Write a highly tailored, compelling, and concise cover letter for this job application.

Job Title: ${job.title}
Company: ${job.company}
Required Skills: ${JSON.stringify(analysis.requiredSkills)}
Tone: ${analysis.tone}

Master Resume:
${config.masterResume}

Strict Rules:
1. The cover letter must be CONCISE and SPECIFIC (maximum 250 words).
2. Reference the company by name, and mention 1-2 specific points about the role or company (using the description) that align with the user's experience.
3. Match the tone: "${analysis.tone}" (startup/casual should be conversational and enthusiastic; enterprise/formal should be polished, structured, and professional).
4. End with a clear call to action (e.g., looking forward to discussing how I can contribute).
5. Do NOT fabricate any experience or achievements.
6. NEVER use square brackets [] or template placeholders like [Hiring Manager], [Company Address], or [Date]. Address it to "Hiring Team" if the manager's name is unknown. Sign off as "Abhay Ramesh" based on the master resume.

Output ONLY the cover letter text as a ready-to-send message. Do not include a formal heading with dates and addresses.
`;

  return await callGemini(prompt, config.geminiApiKey, false);
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
    const result = JSON.parse(responseText.trim());
    return result.confidence || 75;
  } catch (err) {
    console.error('Failed to parse Gemini confidence response:', responseText);
    return 75;
  }
}

// Stage 5.5 - Cold Email Generation
async function generateColdEmail(job, analysis, config, poster) {
  const prompt = `
You are an expert Recruitment Outreach Specialist. Write a short, highly engaging cold email (maximum 150 words) from the candidate to the job poster/recruiter.

Job Title: ${job.title}
Company: ${job.company}
Hiring Team Member: ${poster ? JSON.stringify(poster) : 'Unknown'}
Job Description Requirements: ${JSON.stringify(analysis.requiredSkills)}

Candidate Resume Summary:
${config.masterResume}

Strict Rules:
1. Address the recipient by name if available (e.g. "Dear ${poster && poster.name ? poster.name.split(' ')[0] : 'Hiring Manager'}"), else use a friendly professional greeting like "Dear Hiring Team" or "Dear Recruitment Manager".
2. Write a highly tailored pitch:
   - Identify that you recently saw the opening for "${job.title}".
   - In 2-3 sentences, pitch why your specific background (B.Tech EEE, Embedded Systems/Firmware experience, and key projects like FaceID Access System or Electric Vehicle controls) is an exact match for the requirements.
   - Reference the company name naturally.
3. The email must be extremely concise, punchy, and professional (under 150 words).
4. Do NOT include generic template placeholders (like [Date], [Insert Link], [My Phone]). Use the candidate's real details:
   - Name: Abhay Ramesh
   - Email: abhayramesh000@gmail.com
   - Phone: +91 9961612078
5. Output ONLY the cold email text. No other text, introduction, or markdown block.
`;

  return await callGemini(prompt, config.geminiApiKey, false);
}

module.exports = {
  scoreJob,
  analyzeJob,
  tailorResume,
  generateCoverLetter,
  calculateConfidence,
  generateColdEmail
};
