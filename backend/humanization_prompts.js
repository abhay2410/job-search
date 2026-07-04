/**
 * humanization_prompts.js
 * ----------------------------------------------------------------------
 * Prompt templates for the Auto-Apply Job Pipeline's generation step.
 * Each builder returns { system, user } — pass that pair into your
 * existing LLM Proxy System (Gemini / NVIDIA / OpenRouter).
 *
 * This is meant to sit upstream of your humanizeCleanup post-processor,
 * not replace it: the goal is to get the model to produce text that
 * needs minimal scrubbing in the first place. Merge the BUZZWORDS list
 * below into your existing humanizeCleanup dictionary so the prompt and
 * the post-processor agree on one source of truth.
 *
 * Threshold targets these prompts are written against (matches your
 * test_ai_detection.js scoring bands):
 *   - Resume (structured doc):                 target < 50% AI-likelihood
 *   - Cover letter / cold email / LinkedIn:     target < 25% AI-likelihood
 *
 * Expected `profile` shape — adapt field names to your config.json:
 * {
 *   name: string,
 *   targetRole: string,            // e.g. "ELV/CCTV Technician"
 *   currentEmployer: string,
 *   yearsExperience: string,
 *   coreSkills: string[],
 *   keyProjects: [{ name, stack, impact }],
 *   visaStatus: string,            // e.g. "UAE visit visa valid through
 *                                   //   mid-Aug 2026, in-country mid-July"
 * }
 */

// ---------------------------------------------------------------------
// SHARED RULES
// ---------------------------------------------------------------------

const BUZZWORDS = [
  'leverage', 'delve', 'synergy', 'spearheaded', 'orchestrated',
  'results-oriented professional', 'dynamic', 'passionate about',
  'proven track record', 'innovative', 'cutting-edge',
  'fast-paced environment', 'team player', 'detail-oriented',
  'go-getter', 'hit the ground running', 'wear many hats',
  'think outside the box', 'value-add', 'circle back', 'touch base',
  'low-hanging fruit', 'move the needle', 'foster', 'robust',
  'seamless', 'holistic', 'utilize', 'I am writing to express my interest',
  'I am confident that my skills', "today's fast-paced",
];

const BURSTINESS_RULE = `
SENTENCE RHYTHM (burstiness):
Mix short sentences (3-6 words) with longer ones (15-25 words). Never run
three sentences of similar length back to back — that uniformity is a
stronger AI-detector signal than word choice is.

BAD (uniform, AI-flagged):
"I have extensive experience in embedded systems. I have worked with STM32 and PIC microcontrollers. I am passionate about firmware development."

GOOD (bursty, human-reading):
"Firmware is where I actually live. Over the past year I've taken STM32 and PIC-based IoT devices from schematic review through field debugging — not just the parts that make a clean bullet point."
`.trim();

const SPECIFICITY_RULE = `
SPECIFICITY:
Every claim needs a number, a named tool/protocol, or a named project —
no unsupported adjective standing alone.

BAD: "Improved system performance significantly."
GOOD: "Cut FaceID match latency from ~800ms to under 200ms by switching the FAISS index from flat to IVF."

Never invent numbers or projects that aren't in the profile data passed
in below — specificity has to come from what's true, not what sounds true.
`.trim();

const NO_BUZZWORDS_RULE = `
AVOID THESE WORDS/PHRASES ENTIRELY: ${BUZZWORDS.join(', ')}.
If a sentence needs one of these to make sense, rewrite the sentence —
the cliché is structural, not just lexical, so a synonym swap won't fix it.
`.trim();

const DUBAI_CONTEXT_RULE = `
DUBAI / UAE CONTEXT:
- Register is more formal than US/startup tone — skip "rockstar," "ninja,"
  exclamation points, and overly casual sign-offs.
- State visa/availability status plainly, once, without over-explaining it.
- Don't raise salary or package expectations unprompted — that belongs
  later in the process unless the profile data explicitly says otherwise.
`.trim();

// ---------------------------------------------------------------------
// RESUME — structure stays put; the fix happens at the word level only
// ---------------------------------------------------------------------

function buildResumePrompt({ profile, jobDescription, masterResume }) {
  const system = `
You are rewriting a resume to be tailored to a job description. The output must be a full, complete resume matching the original structure, contact info, dates, company names, education, and credentials, but with humanized and tailored bullets/summaries.

OUTPUT FORMAT (MANDATORY):
- Format the output in strict PLAIN TEXT.
- Do NOT use any Markdown symbols (no #, no **, no *, no code blocks).
- Group sections using ALL CAPS for headers (e.g., PROFESSIONAL SUMMARY, PROFESSIONAL EXPERIENCE, PROJECTS).
- Maintain the original companies, dates, education, and contact details exactly.

DO NOT touch:
- Section structure, dates, titles, company names, contact info.
- Exact keyword phrases that appear in the job description below — match
  them verbatim, even if a "more natural" synonym exists. ATS scoring is
  literal string overlap, not semantic similarity.

DO fix:
- Repeated opening verbs across consecutive bullets — vary "built," "ran,"
  "debugged," "calibrated," "deployed" instead of opening every line with
  "Spearheaded" or "Led."
- Vague claims — replace with the real number, tool, or protocol from the
  profile data.
- Suspiciously round numbers — if the real figure isn't round, keep it
  unrounded ("47%" reads more credible than "50%").

${NO_BUZZWORDS_RULE}

${SPECIFICITY_RULE}

Target: under 50% AI-likelihood on a standard detector scan, without
sacrificing a single ATS keyword match.
`.trim();

  const user = `
JOB DESCRIPTION:
${jobDescription}

ORIGINAL MASTER RESUME:
${masterResume}

CANDIDATE PROJECTS/SKILLS:
${JSON.stringify(profile, null, 2)}

Rewrite the entire resume for this candidate tailored to the job description. Output the full tailored resume in plain text. No preamble, no postamble.
`.trim();

  return { system, user };
}

// ---------------------------------------------------------------------
// SHARED CONVERSATIONAL RULES — cover letter + cold email
// ---------------------------------------------------------------------

const CONVERSATIONAL_BASE = `
${BURSTINESS_RULE}

${SPECIFICITY_RULE}

${NO_BUZZWORDS_RULE}

${DUBAI_CONTEXT_RULE}

Open with something specific to this company or role — never "I am
writing to express my interest in..." Close on the most concrete,
relevant detail you have instead of a generic "I look forward to
hearing from you."

Target: under 25% AI-likelihood on a standard detector scan.
`.trim();

// ---------------------------------------------------------------------
// COVER LETTER
// ---------------------------------------------------------------------

function buildCoverLetterPrompt({ profile, jobDescription, company }) {
  const system = `
You are writing a cover letter for a Dubai job application. Under 200 words.

CRITICAL RULES:
1. Do NOT include any formal header, date, sender address, or recipient address. Start directly with the greeting: "Dear Hiring Team,".
2. Do NOT use placeholder brackets like [Date], [Address], or [Hiring Manager].
3. Do NOT copy the example transformation text verbatim. It is for style guidance only.
4. Keep the body concise: write 3 short paragraphs.
5. End with the sign-off "Best regards," followed by "Abhay Ramesh" on a new line.

${CONVERSATIONAL_BASE}

EXAMPLE TRANSFORMATION (STYLE ONLY — DO NOT COPY):
BAD: "I am a results-oriented professional with a proven track record in embedded systems. I am passionate about leveraging my skills to drive innovation at your company."
GOOD: "Most of my work for the past year has lived inside STM32 and ESP32 firmware — bring-up, debugging, getting IoT devices stable enough to ship. A face-recognition access control system I built end to end, from the RTSP camera feed through FAISS matching to the door relay, is the closest match to what this role needs."
`.trim();

  const user = `
COMPANY: ${company || '(not specified — stay specific to the role itself)'}
JOB DESCRIPTION:
${jobDescription}

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

Write the full cover letter.
`.trim();

  return { system, user };
}

// ---------------------------------------------------------------------
// COLD EMAIL
// ---------------------------------------------------------------------

function buildColdEmailPrompt({ profile, jobDescription, company, recipientName }) {
  const system = `
You are writing a cold outreach email for a Dubai job search. 120-180
words including the subject line — shorter and more direct than a cover
letter, since this gets read on a phone in under 20 seconds.

${CONVERSATIONAL_BASE}

Subject line: specific, not generic. "Embedded Engineer — STM32/IoT,
available July" beats "Application for Open Position."

EXAMPLE TRANSFORMATION:
BAD: "I hope this email finds you well. I am reaching out to express interest in any embedded engineering roles you may have available."
GOOD: "I'll keep this short. One year into embedded work — STM32, PIC, IoT integration — and landing in Dubai mid-July on a visit visa. If there's an opening on your hardware or ELV team, I'd like to talk."
`.trim();

  const user = `
COMPANY: ${company || '(not specified)'}
RECIPIENT: ${recipientName || '(no name — use a plain, non-generic greeting, not "Dear Sir/Madam")'}
JOB DESCRIPTION / ROLE CONTEXT:
${jobDescription}

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

Write the subject line and email body.
`.trim();

  return { system, user };
}

// ---------------------------------------------------------------------
// LINKEDIN CONNECTION NOTE
// ---------------------------------------------------------------------

function buildLinkedInNotePrompt({ profile, recipientName, company }) {
  const system = `
You are writing a LinkedIn connection request note. Hard limit: 300
characters including spaces. Do NOT write more than 280 characters.

CRITICAL RULES:
1. Limit output to ONE or TWO short sentences (under 130 characters total).
2. Never write a formal greeting, introduction, or signature. Just the message.
3. No buzzwords, no clichés, no résumé recap.
4. Keep the tone completely casual, professional, and peer-to-peer.

EXAMPLE:
GOOD: "Hi [Name] — embedded engineer (STM32/IoT) landing in Dubai mid-July, looking at roles at [Company]. Would value connecting ahead of that."

Directly output the note text.
`.trim();

  const user = `
RECIPIENT: ${recipientName || '(no name available)'}
COMPANY: ${company || '(not specified)'}
CANDIDATE PROFILE (context only — do not recap it):
${JSON.stringify(profile, null, 2)}

Write the note. Character count must stay under 300.
`.trim();

  return { system, user };
}

/**
 * Extracts a structured profile object from the application config.json
 */
function extractProfile(config, jobTitle = null) {
  const visaStatus = config.workAuthorization || "Dubai, UAE (Visit Visa)";
  const targetRole = jobTitle 
    ? jobTitle.replace(/ Dubai| UAE/gi, "")
    : (config.targetRoles && config.targetRoles.length > 0 
        ? config.targetRoles[0].replace(/ Dubai| UAE/gi, "") 
        : "Embedded Engineer");
  
  return {
    name: "Abhay Ramesh",
    targetRole: targetRole,
    currentEmployer: "Grapes Innovative Solutions",
    yearsExperience: "1+ years",
    coreSkills: [
      "Embedded C", "C++", "Python", "PIC Microcontrollers", 
      "STM32 Microcontrollers", "Arduino", "Raspberry Pi", 
      "UART", "SPI", "I2C", "CAN", "MS SQL"
    ],
    keyProjects: [
      { 
        name: "FaceID Access System", 
        stack: "InsightFace, FAISS, MS SQL, RTSP streaming", 
        impact: "Developed a deep-learning-based biometric security system for real-time facial authentication with access logging." 
      },
      { 
        name: "Electric Vehicle in College Campus", 
        stack: "Embedded control, components integration", 
        impact: "Designed an EV-based campus transportation system focused on control systems, safety, and energy efficiency." 
      },
      {
        name: "Attendance System",
        stack: "Embedded hardware and software integration",
        impact: "Improved attendance tracking efficiency through automated data processing and monitoring."
      },
      {
        name: "Emergency Call System",
        stack: "Embedded hardware, real-time alerts",
        impact: "Built a real-time emergency alert and communication system for rapid response applications."
      },
      {
        name: "Hospital Automation",
        stack: "Embedded systems, database management",
        impact: "Developed a hospital automation system integrating embedded devices with database management."
      }
    ],
    visaStatus: visaStatus
  };
}

module.exports = {
  buildResumePrompt,
  buildCoverLetterPrompt,
  buildColdEmailPrompt,
  buildLinkedInNotePrompt,
  extractProfile,
  BUZZWORDS,
};
