# Unified Job Application Agent (ApplyPilot + AIHawk Pipeline)

An autonomous job application agent that combines the high-volume discovery, scoring, and automated form-filling of ApplyPilot with the deep job analysis, precise resume tailoring, and personalized cover letter generation of AIHawk. The system includes a local Node.js backend with Playwright and a beautiful, high-end web dashboard built with Vite, React, and Vanilla CSS.

---

## User Review Required

> [!IMPORTANT]
> - **System Requirements & Installation**: Since Node.js and Python are currently not installed in the system PATH, we will install Node.js (LTS version) using `winget` to bootstrap the runtime. Playwright will also download a local chromium binary for automation.
> - **API Credentials**: You will need to provide a Gemini API Key to enable the LLM scoring, analysis, tailoring, and cover letter generation. This will be stored locally in `config.json`.
> - **Master Resume**: You will need to provide your master resume (text/markdown or file upload) along with preferences (target roles, remote preferences, locations, work authorization, salary floor) before starting the pipeline.

---

## Open Questions

> [!IMPORTANT]
> 1. **HR Contact Details & Career Websites**: You requested to "find the contact details of the HR, go to their career website and also do it". 
>    - **HR Contacts**: Should we try to find the HR's email directly by doing a Google search (e.g., "[Company Name] HR email"), or just rely on the LinkedIn Job Poster details we already scrape?
>    - **Career Websites**: Applying on arbitrary career websites is technically challenging because every site is custom. We can add a fallback where if it's not Lever/Greenhouse, Playwright goes to the company's generic career page, attempts to find the application form, and uses our generic auto-fill to complete it. Does this sound like a good approach?
>    - **Cold Emailing**: Would you also like the agent to automatically send a cold email to the HR contact if it finds an email address?
> 2. **Scraping Setup**: Public job scrapers on LinkedIn/Indeed are prone to rate limits, login walls, and IP blocks. We propose a hybrid approach:
>    - Automated keyword search + RSS feed fetching where possible.
>    - A **"Direct Link Import"** box in the dashboard where you can paste any job URL (LinkedIn, Indeed, greenhouse.io, lever.co, workday) for the agent to scrape, analyze, tailor, and apply to immediately.
>    - Do you prefer this hybrid approach, or do you want the agent to focus purely on automated bulk scraping?
> 3. **Manual Review Queue**: When an application falls into the Human Review Queue (e.g. score of 6/10, confidence < 80%, or unusual forms), would you like the browser automation to open in "headed" mode and pause for you to manually complete/review the page in the browser directly?

---

## Proposed Changes

We will build the project from scratch in `f:\job`. The directory structure will look as follows:

```
f:\job\
├── package.json
├── config.json (Local config, user profile, API keys)
├── database.json (Deduplication log, job queue, application history)
├── backend\
│   ├── server.js (Express server, API endpoints)
│   ├── gemini.js (Gemini API integrations)
│   ├── scraper.js (Playwright web scraper for jobs)
│   ├── hr_finder.js (NEW: Web search to find HR contact details and career site URLs)
│   └── applier.js (Playwright automation for job submissions)
└── frontend\
    ├── index.html
    ├── src\
    │   ├── main.jsx
    │   ├── App.jsx
    │   ├── index.css (Premium Dark Mode styles, HSL palettes, Google Fonts)
    │   └── components\
    │       ├── Dashboard.jsx (Pipeline stats, active log streaming)
    │       ├── ProfileConfig.jsx (Resume & preferences setup)
    │       ├── QueueManager.jsx (Scoring, review queue, resume tailors, and cover letters)
    │       └── History.jsx (Structured application logs & rate limiting)
```

---

### System Bootstrapping
Before writing code, we will perform the following setup:
1. Run `winget install OpenJS.NodeJS.LTS` to install Node.js.
2. Initialize npm package: `npm init -y`.
3. Install dependencies:
   - Backend: `express`, `@google/generative-ai`, `playwright`, `dotenv`, `cors`, `google-it` (for searching HR details)
   - Frontend setup via Vite + React.

---

### Backend Logic

#### [NEW] [hr_finder.js](file:///f:/job/backend/hr_finder.js)
A new module to:
- Use Google Search (via `google-it` or Playwright) to find the HR department email or contact details for the scraped company.
- Find the company's official career website link.

#### [MODIFY] [scraper.js](file:///f:/job/backend/scraper.js)
- Integrate `hr_finder.js` after scraping the LinkedIn job.
- Save the HR contact details and Career Site URL into the `database.json` entry for each job.

#### [MODIFY] [applier.js](file:///f:/job/backend/applier.js)
- Add logic to navigate to the company's career website if the LinkedIn Easy Apply or Lever/Greenhouse links are unavailable.
- Implement a more robust generic form-filler that recursively searches the career site for an "Apply" button, navigates to the form, and fills out the application.

#### [NEW] [server.js](file:///f:/job/backend/server.js)
Express server hosting API endpoints for:
- Saving/retrieving configuration & resume.
- Fetching queue status (Discovered, Scored, Ready, Human Review, Submitted).
- Triggering stages (Discovery, Scoring, Tailoring, Application).
- Real-time logging through Server-Sent Events (SSE).

#### [NEW] [gemini.js](file:///f:/job/backend/gemini.js)
Gemini API helper functions:
- Stage 2: Scoring job descriptions (1-10) against user resume.
- Stage 3: Deep Job Analysis (extracting skills, red flags, seniority).
- Stage 4: Resume Tailoring (keyword optimization, bullet point reorganizing, validation logic).
- Stage 5: Cover Letter Generation (matching company tone, concise under 250 words).

---

### Frontend Dashboard

#### [NEW] [index.css](file:///f:/job/frontend/src/index.css)
A highly polished, premium Vanilla CSS stylesheet. Key design elements:
- Palette: Sleek, high-contrast dark theme (deep space background `#0B0C10`, steel grey, neon indigo accents `#4F46E5`, emerald success, warm gold warning).
- Typography: Outfit / Inter Google Font families.
- Interaction: Smooth HSL gradients, glassmorphism cards, micro-animations on hover and active states.

#### [NEW] [App.jsx](file:///f:/job/frontend/src/App.jsx)
Main SPA container with custom navigation tabs: Dashboard, Profile Setup, Pipelines, and History.

#### [NEW] [Dashboard.jsx](file:///f:/job/frontend/src/components/Dashboard.jsx)
Visual breakdown of the application funnel:
- KPI cards (Scraped, High Match, Pending Approval, Applied, Daily Limit 0/30).
- Live execution logs with scrolling container and step-by-step pipeline status.

#### [MODIFY] [QueueManager.jsx](file:///f:/job/frontend/src/components/QueueManager.jsx)
- Update the job card UI to display the extracted HR Contact details and the Career Website link.
- Add a button to manually trigger a cold email to the HR contact if an email is found.

#### [NEW] [ProfileConfig.jsx](file:///f:/job/frontend/src/components/ProfileConfig.jsx)
Interactive form for managing Master Resume (markdown or raw text), Target Roles (comma-separated), Location preferences, Salary Floor, Blacklisted Companies, Work Authorization, and Gemini API Key.

#### [NEW] [History.jsx](file:///f:/job/frontend/src/components/History.jsx)
A structured log table showing all applications (company, role, date, url, score, status) with filtering and deduplication statuses.

---

## Verification Plan

### Automated Tests
- Integration tests for `hr_finder.js` to ensure Google search returns valid email addresses or career URLs.
- Mock Playwright runs against sandbox HTML forms (e.g., standard contact/application forms) to verify generic input mapping and submission pausing on arbitrary career sites.

### Manual Verification
- Deploying the app locally using `npm run dev`.
- Navigating the dashboard, verifying input fields save properly to `config.json`.
- Pasting a live job description, verifying scoring logic, checking the HR contact extraction, and verifying cover letter generation.
- Running a test application on a generic company career site in headed mode to verify the Playwright generic forms automation.
