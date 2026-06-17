const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveProfileDirectory(chromeUserDataPath, profileInput) {
  if (!profileInput) return 'Default';
  
  const directPath = path.join(chromeUserDataPath, profileInput);
  if (fs.existsSync(directPath)) {
    return profileInput;
  }

  try {
    const localStatePath = path.join(chromeUserDataPath, 'Local State');
    if (fs.existsSync(localStatePath)) {
      const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const infoCache = localState.profile?.info_cache;
      if (infoCache) {
        const query = profileInput.toLowerCase().trim();
        for (const [folderName, info] of Object.entries(infoCache)) {
          const name = (info.name || '').toLowerCase();
          const userName = (info.user_name || '').toLowerCase();
          
          if (name === query || userName.includes(query) || folderName.toLowerCase() === query) {
            return folderName;
          }
        }
      }
    }
  } catch (err) {
    console.error('Error reading Chrome Local State:', err);
  }
  
  return 'Default';
}

async function applyToJob(job, config, logFn) {
  let userDataDir = path.join(__dirname, '..', 'user_data');
  const launchOptions = {
    headless: false, // Always headful so the user can see and intervene
    slowMo: 100, // Slow down actions for human-like speed
    viewport: { width: 1280, height: 800 }
  };

  if (config.useLocalChromeProfile && process.env.LOCALAPPDATA) {
    const chromeDataPath = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
    if (fs.existsSync(chromeDataPath)) {
      userDataDir = chromeDataPath;
      const resolvedProfile = resolveProfileDirectory(chromeDataPath, config.chromeProfileName);
      launchOptions.args = [`--profile-directory=${resolvedProfile}`];
      logFn(`Using active Google Chrome user data profile from: ${userDataDir} (Resolved Profile Folder: ${resolvedProfile} from "${config.chromeProfileName || 'Default'}")`, 'info');
      logFn('[WARNING] Please make sure all of your active Google Chrome browser windows are closed, otherwise Playwright cannot lock the profile folder.', 'warning');
      
      // Use chromeExePath from config if provided, otherwise auto-detect
      let chromeExec = null;
      if (config.chromeExePath && fs.existsSync(config.chromeExePath)) {
        chromeExec = config.chromeExePath;
      } else {
        const possibleChromePaths = [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ];
        chromeExec = possibleChromePaths.find(p => fs.existsSync(p));
      }
      if (chromeExec) {
        launchOptions.executablePath = chromeExec;
        logFn(`Using Chrome executable: ${chromeExec}`, 'info');
      } else {
        logFn('WARNING: No Chrome executable found. Using bundled Chromium (may not load your profile correctly).', 'warning');
      }
    } else {
      logFn(`Local Chrome User Data folder not found at: ${chromeDataPath}. Falling back to default project user data directory.`, 'warning');
    }
  } else {
    logFn(`Launching persistent browser context from: ${userDataDir}`, 'info');
  }

  let context = null;
  let page = null;

  try {
    logFn('Initializing persistent browser context...', 'info');
    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();

    logFn(`Navigating to application page: ${job.url}`, 'info');
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(3000);

    // ── LinkedIn Job Listing Detection ────────────────────────────────────
    let fallbackToCareerSite = false;
    const currentUrl = page.url();
    const isLinkedInJobPage = currentUrl.includes('linkedin.com/jobs/view') ||
                              currentUrl.includes('linkedin.com/jobs/collections') ||
                              currentUrl.includes('linkedin.com/jobs/search');

    if (isLinkedInJobPage) {
      logFn('LinkedIn job listing page detected. Looking for Apply button...', 'info');

      // Find the main Apply button on the page
      const applyBtn = await page.$('.jobs-apply-button, button[aria-label*="Apply"], button:has-text("Apply"), a:has-text("Apply")').catch(() => null);
      
      if (applyBtn) {
        const btnText = await page.evaluate(el => el.innerText, applyBtn).catch(() => '');
        const isEasyApply = btnText.toLowerCase().includes('easy apply');

        if (isEasyApply) {
          logFn('Found "Easy Apply" button. Clicking to open application modal...', 'info');
          await applyBtn.scrollIntoViewIfNeeded();
          await applyBtn.click();
          await delay(2500);

          // LinkedIn Easy Apply is a multi-step modal — walk through each step
          logFn('Navigating LinkedIn Easy Apply multi-step form...', 'info');
          let stepCount = 0;
          const MAX_STEPS = 15;

          while (stepCount < MAX_STEPS) {
            stepCount++;
            await delay(1500);

            // Check if we're on the review/submit page
            const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")').catch(() => null);
            if (submitBtn) {
              logFn(`Easy Apply: On review/submit page (step ${stepCount}). Submitting...`, 'info');
              await submitBtn.scrollIntoViewIfNeeded();
              await submitBtn.click();
              await delay(3000);
              logFn('LinkedIn Easy Apply submitted successfully!', 'success');
              await context.close();
              return { success: true, needReview: false, message: 'Applied via LinkedIn Easy Apply.' };
            }

            // Fill any visible inputs on this step
            const stepInputs = await page.$$('input:visible, textarea:visible, select:visible').catch(() => []);
            for (const input of stepInputs) {
              const label = await page.evaluate(el => {
                const id = el.id;
                if (id) { const l = document.querySelector(`label[for="${id}"]`); if (l) return l.innerText; }
                const parent = el.closest('label'); if (parent) return parent.innerText;
                const div = el.closest('div'); if (div) { const s = div.querySelector('span, label'); if (s) return s.innerText; }
                return '';
              }, input).catch(() => '');
              const type = await input.getAttribute('type').catch(() => '');
              const combined = `${label} ${await input.getAttribute('name') || ''} ${await input.getAttribute('id') || ''}`.toLowerCase();

              if (type === 'file') { continue; } // skip file inputs in modal — LinkedIn uses profile resume
              if (combined.includes('phone') || combined.includes('mobile')) {
                const phoneMatch = (config.masterResume || '').match(/(\+?\d[\d\s\-().]{7,}\d)/);
                if (phoneMatch) await input.fill(phoneMatch[0]).catch(() => {});
              } else if (combined.includes('linkedin') || combined.includes('profile')) {
                const liMatch = (config.masterResume || '').match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
                if (liMatch) await input.fill(`https://${liMatch[0]}`).catch(() => {});
              } else if (combined.includes('website') || combined.includes('portfolio')) {
                await input.fill('https://applicant-portfolio.dev').catch(() => {});
              }
            }

            // Check for "Next" or "Continue" button to advance steps
            const nextBtn = await page.$('button[aria-label="Continue to next step"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Review")').catch(() => null);
            if (nextBtn) {
              logFn(`Easy Apply: Advancing to next step (step ${stepCount})...`, 'info');
              await nextBtn.scrollIntoViewIfNeeded();
              await nextBtn.click();
              await delay(1500);
            } else {
              // No next button found — flag for manual completion
              logFn('Easy Apply: Could not find Next/Submit button. Pausing for manual completion.', 'warning');
              await page.waitForEvent('close', { timeout: 0 });
              return { success: true, needReview: true, message: 'LinkedIn Easy Apply paused for manual completion.' };
            }
          }

          logFn('Easy Apply: Reached max step limit. Pausing for manual completion.', 'warning');
          await page.waitForEvent('close', { timeout: 0 });
          return { success: true, needReview: true, message: 'LinkedIn Easy Apply: max steps reached, completed manually.' };

        } else {
          // Look for external "Apply" button that redirects to company ATS
          logFn('Found external "Apply" button. Following to company application page...', 'info');
          const newPagePromise = context.waitForEvent('page').catch(() => null);
          await applyBtn.scrollIntoViewIfNeeded();
          await applyBtn.click();
          
          const newPage = await newPagePromise;
          if (newPage) {
            page = newPage;
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
            logFn(`Followed to external application page: ${page.url()}`, 'info');
          } else {
            await delay(4000);
            logFn(`Stayed on same page or redirected: ${page.url()}`, 'info');
          }
          await delay(2000);
        }
      } else {
        logFn('No Apply button found on LinkedIn page.', 'warning');
        fallbackToCareerSite = true;
      }
    }
    // ── End LinkedIn Detection ────────────────────────────────────────────

    // Check if we navigated away from LinkedIn. If we are still on LinkedIn, do not run form filler.
    const postApplyUrl = page.url();
    const stillOnLinkedIn = postApplyUrl.includes('linkedin.com/jobs') || 
                            postApplyUrl.includes('linkedin.com/search') ||
                            postApplyUrl.includes('linkedin.com/feed');
    
    if (stillOnLinkedIn && isLinkedInJobPage && !fallbackToCareerSite) {
      logFn('External Apply did not navigate away from LinkedIn.', 'warning');
      fallbackToCareerSite = true;
    }

    if (fallbackToCareerSite) {
      if (job.careerSiteUrl) {
         logFn(`Falling back to company career site: ${job.careerSiteUrl}`, 'info');
         await page.goto(job.careerSiteUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
         await delay(3000);
         // Try to find a generic "Apply" button or link on the career page
         const genericApply = await page.$('a:has-text("Apply"), button:has-text("Apply")').catch(() => null);
         if (genericApply) {
            logFn('Found generic Apply button on career site. Clicking...', 'info');
            await genericApply.scrollIntoViewIfNeeded().catch(() => {});
            await genericApply.click().catch(() => {});
            await delay(3000);
         } else {
            logFn('Could not find generic Apply button on career site.', 'warning');
         }
      } else {
         logFn('No career site URL available. Pausing for manual application...', 'warning');
         await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
         return { success: true, needReview: true, message: 'Could not redirect from LinkedIn and no career site found. Please apply manually.' };
      }
    }

    // Save tailored resume to a temporary text file to upload
    const tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    const tempResumePath = path.join(tempDir, `${job.id}_Tailored_Resume.txt`);
    fs.writeFileSync(tempResumePath, job.tailoredResume || config.masterResume || 'Resume content');

    let needReview = false;
    let reviewReason = '';

    // EEO or work authorization questions checking
    const pageText = await page.innerText('body').catch(() => '');
    const eeoKeywords = ['race', 'veteran', 'disability', 'gender', 'lgbtq', 'ethnicity', 'hispanic', 'work authorization', 'sponsorship'];
    const hasEeoOnPage = eeoKeywords.some(kw => pageText.toLowerCase().includes(kw));

    if (hasEeoOnPage) {
      needReview = true;
      reviewReason = 'Form contains potential EEO or work authorization questions.';
    }

    // Auto-filling fields based on common attributes
    const inputs = await page.$$('input, textarea, select');
    logFn(`Analyzing ${inputs.length} form inputs...`, 'info');


    // Split name if needed
    // Parse name from resume (strip markdown # headers)
    const resumeLines = (config.masterResume || '').split('\n');
    let nameFromResume = 'Applicant Name';
    for (const line of resumeLines) {
      const cleaned = line.replace(/^#+\s*/, '').trim();
      if (cleaned.length > 0 && cleaned.length < 40 && !cleaned.includes('|') && !cleaned.includes('@')) {
        nameFromResume = cleaned;
        break;
      }
    }
    const nameParts = nameFromResume.split(/\s+/);
    const firstName = nameParts[0] || 'Applicant';
    const lastName = nameParts.slice(1).join(' ') || 'User';
    logFn(`Parsed applicant name: "${firstName}" "${lastName}"`, 'info');

    for (const input of inputs) {
      try {
        const nameAttr = (await input.getAttribute('name') || '').toLowerCase();
        const idAttr = (await input.getAttribute('id') || '').toLowerCase();
        const placeholderAttr = (await input.getAttribute('placeholder') || '').toLowerCase();
        
        // Locate the label text associated
        const labelText = await page.evaluate((el) => {
          let label = '';
          if (el.id) {
            const lblEl = document.querySelector(`label[for="${el.id}"]`);
            if (lblEl) label = lblEl.innerText;
          }
          if (!label) {
            const parent = el.closest('label');
            if (parent) label = parent.innerText;
          }
          if (!label) {
            // Look for adjacent text or parents
            const parentDiv = el.closest('div');
            if (parentDiv) {
              const spans = parentDiv.querySelectorAll('span, label');
              if (spans.length > 0) label = Array.from(spans).map(s => s.innerText).join(' ');
            }
          }
          return label || '';
        }, input).catch(() => '');

        const combinedId = `${nameAttr} ${idAttr} ${placeholderAttr} ${labelText}`.toLowerCase();

        // Check if it's a file input for Resume
        const typeAttr = await input.getAttribute('type');
        if (typeAttr === 'file' && combinedId.includes('resume')) {
          logFn('Uploading tailored resume...', 'info');
          await input.setInputFiles(tempResumePath);
          await delay(1000);
          continue;
        }

        // Check if it's a file input or text area for Cover Letter
        if (combinedId.includes('cover') || combinedId.includes('letter')) {
          if (typeAttr === 'file') {
            // If they want file, we can write cover letter to text file
            const tempCoverPath = path.join(tempDir, `${job.id}_Cover_Letter.txt`);
            fs.writeFileSync(tempCoverPath, job.coverLetter || 'Cover letter content');
            logFn('Uploading cover letter file...', 'info');
            await input.setInputFiles(tempCoverPath);
          } else if ((await input.evaluate(el => el.tagName)) === 'TEXTAREA' || typeAttr === 'text') {
            logFn('Filling cover letter text area...', 'info');
            await input.fill(job.coverLetter || '');
          }
          await delay(1000);
          continue;
        }

        // Name fields
        if (combinedId.includes('first name') || (combinedId.includes('first') && combinedId.includes('name'))) {
          await input.fill(firstName);
        } else if (combinedId.includes('last name') || (combinedId.includes('last') && combinedId.includes('name'))) {
          await input.fill(lastName);
        } else if (combinedId.includes('full name') || combinedId.includes('name')) {
          await input.fill(nameFromResume);
        }

        // Email
        else if (combinedId.includes('email')) {
          // Look for email in config or extract from resume
          const emailMatch = (config.masterResume || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          const email = emailMatch ? emailMatch[0] : 'applicant@example.com';
          await input.fill(email);
        }

        // Phone
        else if (combinedId.includes('phone') || combinedId.includes('mobile') || combinedId.includes('contact')) {
          const phoneMatch = (config.masterResume || '').match(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
          const phone = phoneMatch ? phoneMatch[0] : '555-0199';
          await input.fill(phone);
        }

        // URLs (LinkedIn, Github, Portfolio)
        else if (combinedId.includes('linkedin')) {
          const linkedinMatch = (config.masterResume || '').match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
          const linkedin = linkedinMatch ? `https://${linkedinMatch[0]}` : 'https://linkedin.com/in/applicant';
          await input.fill(linkedin);
        } else if (combinedId.includes('github')) {
          const githubMatch = (config.masterResume || '').match(/github\.com\/[a-zA-Z0-9_-]+/i);
          const github = githubMatch ? `https://${githubMatch[0]}` : 'https://github.com/applicant';
          await input.fill(github);
        } else if (combinedId.includes('portfolio') || combinedId.includes('website') || combinedId.includes('personal site')) {
          await input.fill('https://applicant-portfolio.dev');
        }

        // Company / Org
        else if (combinedId.includes('company') || combinedId.includes('organization')) {
          await input.fill('Self-Employed / Independent Contractor');
        }

        // If we see checkboxes or text fields containing 'authorized', 'visa', 'sponsor', 'eeo', 'gender', 'race'
        else if (
          combinedId.includes('authorized') || 
          combinedId.includes('sponsor') || 
          combinedId.includes('visa') || 
          combinedId.includes('gender') || 
          combinedId.includes('race') || 
          combinedId.includes('veteran') || 
          combinedId.includes('disability')
        ) {
          needReview = true;
          reviewReason = 'Form contains work authorization or EEO questions.';
          // Highlight in orange/red in the browser
          await input.evaluate(el => el.style.border = '2px solid orange').catch(() => {});
        }

        // Flag unknown/custom textareas as screening questions
        else if ((await input.evaluate(el => el.tagName)) === 'TEXTAREA' && !combinedId.includes('cover')) {
          needReview = true;
          reviewReason = 'Form contains custom screening questions.';
          await input.evaluate(el => el.style.border = '2px solid red').catch(() => {});
        }
      } catch (err) {
        logFn(`Skipping form field due to auto-fill error (might be hidden or removed): ${err.message}`, 'warning');
      }
    }

    // Check confidence score constraint
    if (job.confidence < 80) {
      needReview = true;
      reviewReason = `Application confidence score is below 80% (${job.confidence}%).`;
    }

    // Log the action log
    logFn('--- Application Payload Review ---', 'info');
    logFn(`Name: ${nameFromResume}`, 'info');
    logFn(`Email: mapped from resume`, 'info');
    logFn(`Resume: upload prepared (${path.basename(tempResumePath)})`, 'info');
    logFn(`Cover Letter: prepared (${(job.coverLetter || '').slice(0, 60)}...)`, 'info');
    logFn(`Status Flagged for Review: ${needReview ? 'YES' : 'NO'} (${reviewReason || 'Confidence OK, no EEO/Custom fields'})`, 'info');
    logFn('----------------------------------', 'info');

    if (needReview) {
      logFn(`[MANUAL INTERVENTION REQUIRED] ${reviewReason}`, 'warning');
      logFn('Please complete the remaining questions in the opened browser window. Do not close the window until done.', 'warning');
      
      // Wait for the user to complete and close the window
      await page.waitForEvent('close', { timeout: 0 });
      
      // Clean up temp files
      try { fs.unlinkSync(tempResumePath); } catch(_) {}
      
      return { success: true, needReview: true, message: 'Completed manually by user.' };
    } else {
      logFn('Form successfully pre-filled. Auto-submitting in 5 seconds... Close browser now to abort!', 'info');
      await delay(5000);

      // Attempt to submit automatically
      // Greenhouse: #submit_app
      // Lever: #postings-submit
      const submitGreen = await page.$('#submit_app');
      const submitLever = await page.$('#postings-submit');
      const genericSubmit = await page.$('input[type="submit"], button[type="submit"]');

      if (submitGreen) {
        await submitGreen.scrollIntoViewIfNeeded();
        await submitGreen.click();
        logFn('Greenhouse submit button clicked.', 'success');
      } else if (submitLever) {
        await submitLever.scrollIntoViewIfNeeded();
        await submitLever.click();
        logFn('Lever submit button clicked.', 'success');
      } else if (genericSubmit) {
        await genericSubmit.scrollIntoViewIfNeeded();
        await genericSubmit.click();
        logFn('Generic submit button clicked.', 'success');
      } else {
        logFn('No submit button found. Pausing browser for manual submission...', 'warning');
        await page.waitForEvent('close', { timeout: 0 });
        try { fs.unlinkSync(tempResumePath); } catch(_) {}
        return { success: true, needReview: true, message: 'Paused for manual submission.' };
      }

      await delay(3000); // Wait for redirection/confirmation
      await context.close();
      
      // Clean up temp files
      try { fs.unlinkSync(tempResumePath); } catch(_) {}
      
      return { success: true, needReview: false, message: 'Application submitted successfully.' };
    }

  } catch (err) {
    let cleanMsg = err.message || '';
    if (cleanMsg.includes('DevTools remote debugging requires a non-default data directory') || 
        cleanMsg.includes('lock') || 
        cleanMsg.includes('Timeout') || 
        cleanMsg.includes('launchPersistentContext')) {
      if (config.useLocalChromeProfile) {
        logFn('CRITICAL ERROR: Failed to launch browser using local Chrome Profile. This is usually caused by Chrome locking the profile folder, or Chrome security policies blocking DevTools remote debugging on the default User Data directory.', 'error');
        logFn('RECOMMENDED FIX: Go to the "Profile Setup" tab in the dashboard, disable "Use my active Google Chrome profile", save, and click the "Open Automation Browser" button to sign in to LinkedIn.', 'warning');
      }
    }
    logFn(`Error during auto-application: ${cleanMsg}`, 'error');
    if (page) {
      logFn('Leaving browser window open for debugging. Close it manually to finish.', 'warning');
      await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
    return { success: false, needReview: false, message: cleanMsg };
  }
}

module.exports = {
  applyToJob
};
