const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const formAnswerer = require('./formAnswerer');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Max time to wait for the user to manually close the browser (10 minutes)
const MANUAL_CLOSE_TIMEOUT = 10 * 60 * 1000;

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

async function applyToJob(job, config, logFn, askTelegramFn = null) {
  let userDataDir = path.join(__dirname, '..', 'user_data');
  const launchOptions = {
    headless: false,
    slowMo: 100,
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

    logFn('Initializing persistent browser context...', 'info');
    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();

    logFn(`Navigating to application page: ${job.url}`, 'info');
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(3000);

    // ── LinkedIn Job Listing Detection ────────────────────────────────────
    let ranEasyApply = false;
    let fallbackToCareerSite = false;
    const currentUrl = page.url();
    const isLinkedInJobPage = currentUrl.includes('linkedin.com/jobs/view') ||
                              currentUrl.includes('linkedin.com/jobs/collections') ||
                              currentUrl.includes('linkedin.com/jobs/search');

    if (isLinkedInJobPage) {
      logFn('LinkedIn job listing page detected. Looking for Apply button...', 'info');

      const applyBtn = await page.$('.jobs-apply-button, button[aria-label*="Apply"], button:has-text("Apply"), a:has-text("Apply")').catch(() => null);
      
      if (applyBtn) {
        const btnText = await page.evaluate(el => el.innerText, applyBtn).catch(() => '');
        const isEasyApply = btnText.toLowerCase().includes('easy apply');

        if (isEasyApply) {
          logFn('Found "Easy Apply" button. Clicking to open application modal...', 'info');
          await applyBtn.scrollIntoViewIfNeeded();
          await applyBtn.click();
          await delay(2500);

          logFn('Navigating LinkedIn Easy Apply multi-step form...', 'info');
          let stepCount = 0;
          const MAX_STEPS = 20;
          // Fix: use null (not '') so first iteration doesn't falsely match
          let lastProgressText = null;
          let stuckCount = 0;

          while (stepCount < MAX_STEPS) {
            stepCount++;
            await delay(2000);

            // ── Check for "already applied" ──
            const alreadyApplied = await page.$('h2:has-text("Application submitted"), span:has-text("You already applied")').catch(() => null);
            if (alreadyApplied) {
              logFn('LinkedIn Easy Apply: Application already submitted or duplicate detected.', 'info');
              await context.close();
              return { success: true, needReview: false, message: 'Already applied to this job on LinkedIn.' };
            }

            // ── Read progress indicator ──
            const progressText = await page.evaluate(() => {
              const header = document.querySelector('.jobs-easy-apply-modal h2, .artdeco-modal__header h2, [class*="jobs-easy-apply"] h3');
              const progress = document.querySelector('.artdeco-completeness-meter-linear__progress-element, [role="progressbar"]');
              return (header?.innerText || '') + '|' + (progress?.getAttribute('aria-valuenow') || '');
            }).catch(() => '');

            // Fix: skip stuck detection on step 1 — modal may still be loading
            if (stepCount > 1) {
              if (progressText && lastProgressText !== null && progressText === lastProgressText) {
                stuckCount++;
                logFn(`Easy Apply: Same step detected (stuck count: ${stuckCount}/3). Checking for validation errors...`, 'warning');

                const errorMsgs = await page.$$eval(
                  '.artdeco-inline-feedback--error, [data-test-form-element-error], .fb-form-element__error-text, .artdeco-text-input--error',
                  els => els.map(el => el.innerText.trim()).filter(Boolean)
                ).catch(() => []);

                if (errorMsgs.length > 0) {
                  logFn(`Easy Apply: Validation errors found: ${errorMsgs.join('; ')}`, 'warning');
                }

                if (stuckCount >= 3) {
                  logFn('Easy Apply: Stuck on same step for 3 iterations. Pausing for manual completion.', 'warning');
                  await page.waitForEvent('close', { timeout: MANUAL_CLOSE_TIMEOUT }).catch(() => {});
                  await context.close().catch(() => {});
                  return { success: true, needReview: true, message: 'LinkedIn Easy Apply stuck on a step — requires manual completion.' };
                }
              } else {
                stuckCount = 0;
                lastProgressText = progressText;
              }
            } else {
              // Step 1: just record current state, don't check stuck
              lastProgressText = progressText;
            }

            // ── Check if we're on the review/submit page ──
            const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")').catch(() => null);
            if (submitBtn) {
              logFn(`Easy Apply: On review/submit page (step ${stepCount}). Submitting...`, 'info');

              const followCheckbox = await page.$('input[type="checkbox"][id*="follow"], label:has-text("Follow") input[type="checkbox"]').catch(() => null);
              if (followCheckbox) {
                const isChecked = await followCheckbox.isChecked().catch(() => false);
                if (isChecked) {
                  await followCheckbox.uncheck().catch(() => {});
                  logFn('Easy Apply: Unchecked "Follow company" checkbox.', 'info');
                }
              }

              await submitBtn.scrollIntoViewIfNeeded();
              await submitBtn.click();
              await delay(3000);

              const postSubmitConfirm = await page.$('h2:has-text("Application sent"), span:has-text("Application sent"), h3:has-text("submitted")').catch(() => null);
              if (postSubmitConfirm) {
                logFn('LinkedIn Easy Apply submitted successfully! Confirmation detected.', 'success');
              } else {
                logFn('LinkedIn Easy Apply: Submit button clicked. Assuming success.', 'success');
              }

              const dismissBtn = await page.$('button[aria-label="Dismiss"], button:has-text("Done"), button:has-text("Not now")').catch(() => null);
              if (dismissBtn) await dismissBtn.click().catch(() => {});
              
              await context.close().catch(() => {});
              ranEasyApply = true;
              return { success: true, needReview: false, message: 'Applied via LinkedIn Easy Apply.' };
            }

            // ── Fill all visible inputs on this step ──
            logFn(`Easy Apply: Processing form fields on step ${stepCount}...`, 'info');

            // Scope all queries to the Easy Apply modal container
            let modal = null;
            const modalSelectors = [
              '.jobs-easy-apply-modal',
              '.artdeco-modal',
              '[class*="jobs-easy-apply"]',
              'div[role="dialog"]',
              '.artdeco-modal-overlay .artdeco-modal__content',
              '.artdeco-modal-overlay',
              'form[class*="jobs-easy-apply"]',
              '.jobs-easy-apply-form-section',
            ];
            for (const sel of modalSelectors) {
              modal = await page.$(sel).catch(() => null);
              if (modal) {
                logFn(`  Modal found via: "${sel}"`, 'info');
                break;
              }
            }
            if (!modal) {
              logFn('Easy Apply: Modal container not found via CSS. Using page-level with skip filter.', 'warning');
            }
            const formScope = modal || page;

            // Labels to skip — navigation/search elements, not form fields
            const SKIP_LABELS = ['search', 'filter', 'sort', 'messaging', 'notifications', 'home', 'my network', 'jobs'];

            // ── Handle SELECT dropdowns ──
            // Fix: don't use :visible — use isVisible() per-element
            const selects = await formScope.$$('select').catch(() => []);
            for (const select of selects) {
              // Fix: proper Playwright visibility check
              const visible = await select.isVisible().catch(() => false);
              if (!visible) continue;

              const currentVal = await select.inputValue().catch(() => '');
              if (currentVal && currentVal !== '' && currentVal !== 'Select an option') continue;

              const selectLabel = await page.evaluate(el => {
                const id = el.id;
                if (id) { const l = document.querySelector(`label[for="${id}"]`); if (l) return l.innerText.trim(); }
                const container = el.closest('.fb-dash-form-element, .jobs-easy-apply-form-section__grouping');
                if (container) { const l = container.querySelector('label, span.t-14'); if (l) return l.innerText.trim(); }
                return '';
              }, select).catch(() => '');
              const selectLabelLower = selectLabel.toLowerCase();
              if (SKIP_LABELS.includes(selectLabelLower)) continue;

              const options = await select.$$eval('option', els => els.map(el => ({ value: el.value, text: el.innerText.trim() }))).catch(() => []);
              const optionTexts = options.filter(o => o.text && o.text !== 'Select an option').map(o => o.text);

              logFn(`  Select field: "${selectLabel}" (options: ${optionTexts.slice(0, 5).join(', ')}${optionTexts.length > 5 ? '...' : ''})`, 'info');

              // Use formAnswerer for smart selection
              const answeredText = await formAnswerer.answerQuestion({
                label: selectLabel,
                type: 'select',
                options: optionTexts,
                job,
                config,
                logFn
              });

              if (answeredText) {
                const matched = options.find(o => o.text === answeredText || o.text.toLowerCase().includes(answeredText.toLowerCase()));
                if (matched) {
                  await select.selectOption(matched.value).catch(() => {});
                  logFn(`  → Selected: "${matched.text}"`, 'info');
                }
              }
              await delay(500);
            }

            // ── Handle RADIO buttons (grouped by name) ──
            const processedRadioNames = new Set();
            // Fix: don't use :visible — query all, check visibility per element
            const radios = await formScope.$$('input[type="radio"]').catch(() => []);
            for (const radio of radios) {
              const visible = await radio.isVisible().catch(() => false);
              if (!visible) continue;

              const radioName = await radio.getAttribute('name').catch(() => '');
              if (!radioName || processedRadioNames.has(radioName)) continue;
              processedRadioNames.add(radioName);

              const anyChecked = await page.$(`input[type="radio"][name="${radioName}"]:checked`).catch(() => null);
              if (anyChecked) continue;

              const groupRadios = await page.$$(`input[type="radio"][name="${radioName}"]`);
              const radioOptions = [];
              for (const r of groupRadios) {
                const rId = await r.getAttribute('id').catch(() => '');
                let rLabel = '';
                if (rId) {
                  rLabel = await page.evaluate(id => {
                    const lbl = document.querySelector(`label[for="${id}"]`);
                    return lbl ? lbl.innerText.trim() : '';
                  }, rId).catch(() => '');
                }
                if (!rLabel) {
                  rLabel = await page.evaluate(el => el.closest('label')?.innerText.trim() || '', r).catch(() => '');
                }
                radioOptions.push(rLabel || 'Option');
              }

              const radioGroupLabel = await page.evaluate(name => {
                const firstRadio = document.querySelector(`input[type="radio"][name="${name}"]`);
                if (!firstRadio) return '';
                const section = firstRadio.closest('.fb-dash-form-element, .jobs-easy-apply-form-section__grouping, fieldset');
                if (section) {
                  const legend = section.querySelector('legend, label, span.t-14, span.t-bold');
                  if (legend) return legend.innerText.trim();
                }
                return '';
              }, radioName).catch(() => '');

              const radioGroupLabelLower = radioGroupLabel.toLowerCase();
              if (SKIP_LABELS.includes(radioGroupLabelLower)) continue;
              logFn(`  Radio group: "${radioGroupLabel}" (options: ${radioOptions.join(', ')})`, 'info');

              // Use formAnswerer to pick the right option
              const answeredText = await formAnswerer.answerQuestion({
                label: radioGroupLabel,
                type: 'radio',
                options: radioOptions,
                job,
                config,
                logFn
              });

              if (answeredText) {
                let pickIndex = radioOptions.findIndex(o => o === answeredText || o.toLowerCase().includes(answeredText.toLowerCase()));
                if (pickIndex === -1) pickIndex = 0;
                if (pickIndex >= 0 && pickIndex < groupRadios.length) {
                  await groupRadios[pickIndex].scrollIntoViewIfNeeded().catch(() => {});
                  await groupRadios[pickIndex].click().catch(() => {});
                  logFn(`  → Selected: "${radioOptions[pickIndex]}"`, 'info');
                }
              }
              await delay(500);
            }

            // ── Handle TEXT inputs and TEXTAREAS ──
            // Fix: don't use :visible in selector — use isVisible() per element
            const textInputs = await formScope.$$('input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input[type="url"], textarea').catch(() => []);
            for (const input of textInputs) {
              const visible = await input.isVisible().catch(() => false);
              if (!visible) continue;

              const tagName = await input.evaluate(el => el.tagName).catch(() => '');
              const typeAttr = await input.getAttribute('type').catch(() => 'text');
              const currentValue = await input.inputValue().catch(() => '');
              if (currentValue && currentValue.trim() !== '') continue;

              // Double-check it's inside the modal
              const isInModal = await input.evaluate(el => !!el.closest('.jobs-easy-apply-modal, .artdeco-modal, [class*="jobs-easy-apply"]')).catch(() => false);
              if (!isInModal) continue;

              const inputLabel = await page.evaluate(el => {
                const id = el.id;
                if (id) { const l = document.querySelector(`label[for="${id}"]`); if (l) return l.innerText.trim(); }
                const container = el.closest('.fb-dash-form-element, .jobs-easy-apply-form-section__grouping');
                if (container) { const l = container.querySelector('label, span.t-14'); if (l) return l.innerText.trim(); }
                const parent = el.closest('label');
                if (parent) return parent.innerText.trim();
                return el.getAttribute('placeholder') || '';
              }, input).catch(() => '');

              const inputLabelLower = inputLabel.toLowerCase();
              if (SKIP_LABELS.includes(inputLabelLower) || inputLabelLower === '' || inputLabelLower.includes('search')) continue;

              // Use formAnswerer for smart filling
              const fillValue = await formAnswerer.answerQuestion({
                label: inputLabel,
                type: tagName === 'TEXTAREA' ? 'textarea' : (typeAttr || 'text'),
                options: [],
                job,
                config,
                logFn
              });

              if (fillValue) {
                await input.click().catch(() => {});
                await input.fill(String(fillValue)).catch(() => {});
                logFn(`  → Filled "${inputLabel}": "${String(fillValue).substring(0, 60)}${fillValue.length > 60 ? '...' : ''}"`, 'info');
                await delay(300);
              }
            }

            // ── Handle file inputs (resume upload) ──
            const fileInputs = await page.$$('input[type="file"]').catch(() => []);
            for (const fileInput of fileInputs) {
              const fileLabel = await page.evaluate(el => {
                const container = el.closest('.fb-dash-form-element, .jobs-easy-apply-form-section__grouping');
                if (container) { const l = container.querySelector('label, span'); if (l) return l.innerText.trim(); }
                return '';
              }, fileInput).catch(() => '');
              if (fileLabel.toLowerCase().includes('resume') || fileLabel.toLowerCase().includes('cv')) {
                const tempDir = path.join(__dirname, '..', 'temp');
                if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
                const tempResumePath = path.join(tempDir, `${job.id}_Tailored_Resume.txt`);
                fs.writeFileSync(tempResumePath, job.tailoredResume || config.masterResume || 'Resume content');
                await fileInput.setInputFiles(tempResumePath).catch(() => {});
                logFn(`  → Uploaded resume for "${fileLabel}"`, 'info');
                await delay(1000);
              }
            }

            // ── Handle checkboxes (terms/consent) ──
            const checkboxes = await page.$$('input[type="checkbox"]').catch(() => []);
            for (const cb of checkboxes) {
              const cbVisible = await cb.isVisible().catch(() => false);
              if (!cbVisible) continue;
              const isChecked = await cb.isChecked().catch(() => true);
              if (!isChecked) {
                const cbLabel = await page.evaluate(el => {
                  const id = el.id;
                  if (id) { const l = document.querySelector(`label[for="${id}"]`); if (l) return l.innerText.trim(); }
                  return el.closest('label')?.innerText.trim() || '';
                }, cb).catch(() => '');
                const cbLabelLower = cbLabel.toLowerCase();
                if (cbLabelLower.includes('terms') || cbLabelLower.includes('agree') || cbLabelLower.includes('consent') || cbLabelLower.includes('acknowledge') || cbLabelLower.includes('certify')) {
                  await cb.check().catch(() => {});
                  logFn(`  → Checked: "${cbLabel}"`, 'info');
                }
              }
            }

            // ── Advance to next step ──
            const nextBtn = await page.$('button[aria-label="Continue to next step"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Review")').catch(() => null);
            if (nextBtn) {
              const isDisabled = await nextBtn.isDisabled().catch(() => false);
              if (isDisabled) {
                logFn(`Easy Apply: Next button is disabled (step ${stepCount}). Required fields may be missing.`, 'warning');
                stuckCount++;
                if (stuckCount >= 3) {
                  logFn('Easy Apply: Button disabled for 3 iterations. Pausing for manual completion.', 'warning');
                  await page.waitForEvent('close', { timeout: MANUAL_CLOSE_TIMEOUT }).catch(() => {});
                  await context.close().catch(() => {});
                  return { success: true, needReview: true, message: 'LinkedIn Easy Apply: required fields could not be filled.' };
                }
                continue;
              }
              logFn(`Easy Apply: Advancing to next step (step ${stepCount})...`, 'info');
              await nextBtn.scrollIntoViewIfNeeded();
              await nextBtn.click();
              await delay(1500);
            } else {
              logFn('Easy Apply: Could not find Next/Submit button. Pausing for manual completion.', 'warning');
              await page.waitForEvent('close', { timeout: MANUAL_CLOSE_TIMEOUT }).catch(() => {});
              await context.close().catch(() => {});
              return { success: true, needReview: true, message: 'LinkedIn Easy Apply paused for manual completion.' };
            }
          }

          logFn('Easy Apply: Reached max step limit. Pausing for manual completion.', 'warning');
          await page.waitForEvent('close', { timeout: MANUAL_CLOSE_TIMEOUT }).catch(() => {});
          await context.close().catch(() => {});
          return { success: true, needReview: true, message: 'LinkedIn Easy Apply: max steps reached, completed manually.' };

        } else {
          // External "Apply" button — follows to company ATS
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

    // Fix: if Easy Apply ran and returned successfully, we already returned above.
    // Only proceed to generic ATS filler if we didn't complete via Easy Apply.
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
         await page.waitForEvent('close', { timeout: MANUAL_CLOSE_TIMEOUT }).catch(() => {});
         return { success: true, needReview: true, message: 'Could not redirect from LinkedIn and no career site found. Please apply manually.' };
      }
    }

    // ── Generic ATS Form Filler (Greenhouse, Lever, Workday, etc.) ────────
    // Fix: only runs for non-LinkedIn / external ATS pages
    const tempDir = path.join(__dirname, '..', 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }
    const tempResumePath = path.join(tempDir, `${job.id}_Tailored_Resume.txt`);
    fs.writeFileSync(tempResumePath, job.tailoredResume || config.masterResume || 'Resume content');

    let needReview = false;
    let reviewReason = '';

    const inputs = await page.$$('input, textarea, select');
    logFn(`Analyzing ${inputs.length} form inputs...`, 'info');
    logFn(`Parsed applicant name: "${firstName}" "${lastName}"`, 'info');

    const processedElements = new Set();
    const processedRadios = new Set();

    for (const input of inputs) {
      try {
        const tagName = await input.evaluate(el => el.tagName);
        const typeAttr = await input.getAttribute('type') || '';
        const nameAttr = await input.getAttribute('name') || '';
        const idAttr = await input.getAttribute('id') || '';
        const placeholderAttr = (await input.getAttribute('placeholder') || '').toLowerCase();
        
        const elementKey = idAttr || nameAttr || `${tagName}_${await input.evaluate(el => el.getBoundingClientRect().top)}`;
        if (processedElements.has(elementKey)) continue;
        processedElements.add(elementKey);

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
            const parentDiv = el.closest('div');
            if (parentDiv) {
              const spans = parentDiv.querySelectorAll('span, label');
              if (spans.length > 0) label = Array.from(spans).map(s => s.innerText).join(' ');
            }
          }
          return label || '';
        }, input).catch(() => '');

        const combinedId = `${nameAttr} ${idAttr} ${placeholderAttr} ${labelText}`.toLowerCase();

        // 1. Resume file upload
        if (typeAttr === 'file' && combinedId.includes('resume')) {
          logFn('Uploading tailored resume...', 'info');
          await input.setInputFiles(tempResumePath);
          await delay(1000);
          continue;
        }

        // 2. Cover Letter
        if (combinedId.includes('cover') || combinedId.includes('letter')) {
          if (typeAttr === 'file') {
            const tempCoverPath = path.join(tempDir, `${job.id}_Cover_Letter.txt`);
            fs.writeFileSync(tempCoverPath, job.coverLetter || 'Cover letter content');
            logFn('Uploading cover letter file...', 'info');
            await input.setInputFiles(tempCoverPath);
          } else if (tagName === 'TEXTAREA' || typeAttr === 'text') {
            logFn('Filling cover letter text area...', 'info');
            await input.fill(job.coverLetter || '');
          }
          await delay(1000);
          continue;
        }

        // 3. Name fields (fast-path — no LLM needed)
        if (combinedId.includes('first name') || (combinedId.includes('first') && combinedId.includes('name'))) {
          await input.fill(firstName);
          continue;
        }
        if (combinedId.includes('last name') || (combinedId.includes('last') && combinedId.includes('name'))) {
          await input.fill(lastName);
          continue;
        }
        if (combinedId.includes('full name') || (combinedId.includes('name') && !combinedId.includes('company') && !combinedId.includes('school') && !combinedId.includes('university'))) {
          await input.fill(nameFromResume);
          continue;
        }

        // 4. Email
        if (combinedId.includes('email')) {
          const emailMatch = (config.masterResume || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          const email = emailMatch ? emailMatch[0] : 'applicant@example.com';
          await input.fill(email);
          continue;
        }

        // 5. Phone
        if (combinedId.includes('phone') || combinedId.includes('mobile') || combinedId.includes('contact')) {
          const phoneMatch = (config.masterResume || '').match(/(\+?\d[\d\s\-().]{7,}\d)/);
          const phone = phoneMatch ? phoneMatch[0] : '';
          if (phone) await input.fill(phone);
          continue;
        }

        // 6. Social URLs
        if (combinedId.includes('linkedin')) {
          const linkedinMatch = (config.masterResume || '').match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
          const linkedin = linkedinMatch ? `https://${linkedinMatch[0]}` : '';
          if (linkedin) await input.fill(linkedin);
          continue;
        }
        if (combinedId.includes('github')) {
          const githubMatch = (config.masterResume || '').match(/github\.com\/[a-zA-Z0-9_-]+/i);
          const github = githubMatch ? `https://${githubMatch[0]}` : '';
          if (github) await input.fill(github);
          continue;
        }
        if (combinedId.includes('portfolio') || combinedId.includes('website') || combinedId.includes('personal site')) {
          const liMatch = (config.masterResume || '').match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
          await input.fill(liMatch ? `https://${liMatch[0]}` : '');
          continue;
        }

        // 7. Company
        if (combinedId.includes('company') || combinedId.includes('organization')) {
          await input.fill(config.currentCompany || 'Not currently employed');
          continue;
        }

        // 8. All other fields → formAnswerer (LLM with cache)
        const questionLabel = labelText || placeholderAttr || nameAttr || '';
        if (!questionLabel) continue;

        if (tagName === 'SELECT') {
          const options = await input.$$eval('option', els => els.map(el => el.innerText.trim()).filter(Boolean));
          const answeredText = await formAnswerer.answerQuestion({
            label: questionLabel,
            type: 'select',
            options,
            job,
            config,
            logFn
          });
          if (answeredText) {
            await input.selectOption({ label: answeredText }).catch(async () => {
              await input.selectOption(answeredText).catch(() => {});
            });
            logFn(`  → Selected: "${answeredText}"`, 'info');
          } else {
            needReview = true;
            reviewReason = reviewReason || `Could not answer select field: "${questionLabel}"`;
          }
          continue;
        }

        if (typeAttr === 'radio') {
          if (nameAttr && !processedRadios.has(nameAttr)) {
            processedRadios.add(nameAttr);
            const radios = await page.$$(`input[type="radio"][name="${nameAttr}"]`);
            const options = [];
            for (const radio of radios) {
              const rId = await radio.getAttribute('id');
              let label = '';
              if (rId) {
                label = await page.evaluate(elId => {
                  const lbl = document.querySelector(`label[for="${elId}"]`);
                  return lbl ? lbl.innerText.trim() : '';
                }, rId);
              }
              if (!label) label = await page.evaluate(el => el.closest('label')?.innerText.trim() || '', radio);
              options.push(label || 'Option');
            }
            const answeredText = await formAnswerer.answerQuestion({
              label: questionLabel,
              type: 'radio',
              options,
              job,
              config,
              logFn
            });
            if (answeredText) {
              for (let idx = 0; idx < options.length; idx++) {
                if (options[idx] === answeredText || options[idx].toLowerCase().includes(answeredText.toLowerCase())) {
                  await radios[idx].scrollIntoViewIfNeeded();
                  await radios[idx].click();
                  logFn(`  → Picked radio: "${options[idx]}"`, 'info');
                  break;
                }
              }
            }
          }
          continue;
        }

        // Text / textarea
        const currentValue = await input.inputValue().catch(() => '');
        if (currentValue && currentValue.trim() !== '') continue;

        const fillValue = await formAnswerer.answerQuestion({
          label: questionLabel,
          type: tagName === 'TEXTAREA' ? 'textarea' : (typeAttr || 'text'),
          options: [],
          job,
          config,
          logFn
        });

        if (fillValue) {
          await input.fill(String(fillValue)).catch(() => {});
          logFn(`  → Filled "${questionLabel}": "${String(fillValue).substring(0, 60)}..."`, 'info');
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

    logFn('--- Application Payload Review ---', 'info');
    logFn(`Name: ${nameFromResume}`, 'info');
    logFn(`Resume: upload prepared (${path.basename(tempResumePath)})`, 'info');
    logFn(`Cover Letter: prepared (${(job.coverLetter || '').slice(0, 60)}...)`, 'info');
    logFn(`Status Flagged for Review: ${needReview ? 'YES' : 'NO'} (${reviewReason || 'Confidence OK, no blockers'})`, 'info');
    logFn('----------------------------------', 'info');

    if (needReview) {
      logFn(`[MANUAL INTERVENTION REQUIRED] ${reviewReason}`, 'warning');
      logFn('Please complete the remaining questions in the opened browser window. Do not close the window until done.', 'warning');
      
      await page.waitForEvent('close', { timeout: MANUAL_CLOSE_TIMEOUT });
      
      try { fs.unlinkSync(tempResumePath); } catch(_) {}
      
      return { success: true, needReview: true, message: 'Completed manually by user.' };
    } else {
      logFn('Form successfully pre-filled. Auto-submitting in 5 seconds... Close browser now to abort!', 'info');
      await delay(5000);

      // Try common submit button selectors
      const submitGreen  = await page.$('#submit_app');
      const submitLever  = await page.$('#postings-submit');
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
        await page.waitForEvent('close', { timeout: MANUAL_CLOSE_TIMEOUT });
        try { fs.unlinkSync(tempResumePath); } catch(_) {}
        return { success: true, needReview: true, message: 'Paused for manual submission.' };
      }

      await delay(3000);
      await context.close();
      
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
      await page.waitForEvent('close', { timeout: MANUAL_CLOSE_TIMEOUT }).catch(() => {});
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
