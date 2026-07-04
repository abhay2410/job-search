const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { findHrDetails } = require('./hr_finder');
const { ApifyClient } = require('apify-client');

// Helper for human-like delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Scrape single URL
async function scrapeJobUrl(url, logFn, configInput = null) {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('Cannot navigate to invalid or empty URL.');
  }
  let config = configInput;
  if (!config) {
    try {
      const configPath = path.join(__dirname, '..', 'config.json');
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (e) {
      // ignore
    }
  }

  const userAgent = getRandomUserAgent();
  logFn(`Launching browser for single URL scrape (User-Agent: ...${userAgent.slice(-20)})...`, 'info');

  const browser = await launchScraperBrowser(config);
  const context = await browser.newContext({ userAgent, locale: 'en-US' });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2000 + Math.random() * 2000); // Random delay

    let title = '';
    let company = '';
    let description = '';
    let posterName = '';
    let posterTitle = '';
    let posterUrl = '';

    const lowerUrl = url.toLowerCase();

    if (lowerUrl.includes('greenhouse.io')) {
      title = await page.locator('h1.app-title').innerText().catch(() => '');
      company = await page.locator('span.company-name').innerText().catch(() => '');
      if (company) {
        // Greenhouse format is often "at CompanyName"
        company = company.replace(/at\s+/i, '').trim();
      }
      description = await page.locator('div#content').innerText().catch(() => '');
    } else if (lowerUrl.includes('lever.co')) {
      title = await page.locator('div.posting-header h2').innerText().catch(() => '');
      company = await page.locator('div.posting-header div.categories-department').innerText().catch(() => '');
      // Lever usually has company name in the URL or page title
      const pageTitle = await page.title();
      if (pageTitle.includes('-')) {
        company = pageTitle.split('-')[0].trim();
      }
      description = await page.locator('div.section.page-centered').allInnerTexts().then(texts => texts.join('\n')).catch(() => '');
    } else if (lowerUrl.includes('linkedin.com/jobs')) {
      // Improved robust selectors for LinkedIn detail page
      title = await page.locator('h1.top-card-layout__title, h2.job-search-card__title, h1.topcard__title, .top-card-layout__title').first().innerText().catch(() => '');
      if (!title) {
        const pageTitle = await page.title();
        title = pageTitle.split(' hiring ')[0] || pageTitle.split('|')[0] || '';
      }
      
      company = await page.locator('a.topcard__org-name-link, span.topcard__flavor, a.top-card-layout__subtitle-link, .topcard__flavor').first().innerText().catch(() => '');
      if (!company) {
        const pageTitle = await page.title();
        company = pageTitle.split(' hiring ')[1]?.split(' in ')[0] || 'Unknown Company';
      }
      
      description = await page.locator('div.show-more-less-html__markup, div.description__text, .description__text--rich, section.description').first().innerText().catch(() => '');

      // Extract job poster details if available
      posterName = await page.locator('.message-the-poster__name, .hiring-team-card__name, .hiring-manager__name, .hiring-team__name, .message-the-poster__profile-link').first().innerText().catch(() => '');
      posterTitle = await page.locator('.message-the-poster__headline, .message-the-poster__title, .hiring-team-card__headline, .hiring-manager__headline, .hiring-team__headline').first().innerText().catch(() => '');
      posterUrl = await page.locator('a.message-the-poster__profile-link, a.hiring-team-card__link, a.hiring-team__profile-link, a.hiring-manager__profile-link').first().getAttribute('href').catch(() => '');
    } else if (lowerUrl.includes('indeed.com')) {
      title = await page.locator('h1.jobsearch-JobInfoHeader-title, h1').first().innerText().catch(() => '');
      company = await page.locator('[data-testid="inlineHeader-companyName"] a, .jobsearch-CompanyReview--heading a, span[data-testid="company-name"]').first().innerText().catch(() => '');
      description = await page.locator('#jobDescriptionText').first().innerText().catch(() => '');
    } else if (lowerUrl.includes('gulftalent.com')) {
      title = await page.locator('h1').first().innerText().catch(() => '');
      company = await page.locator('.company-name, a[href*="/companies/"]').first().innerText().catch(() => '');
      description = await page.locator('.job-description, .description').first().innerText().catch(() => '');
    }

    // Fallback parser for generic sites
    if (!title || !description) {
      logFn('Running generic parser fallback...', 'info');
      title = await page.locator('h1').first().innerText().catch(() => '');
      const pageTitle = await page.title();
      if (!title && pageTitle) {
        title = pageTitle.split('|')[0].split('-')[0].trim();
      }
      company = pageTitle.split('|')[1]?.trim() || pageTitle.split('-')[1]?.trim() || 'Unknown Company';
      
      // Get readable paragraphs
      description = await page.evaluate(() => {
        const divs = Array.from(document.querySelectorAll('div, p, li'));
        let bestText = '';
        let maxLength = 0;
        divs.forEach(el => {
          const text = el.innerText || '';
          if (text.length > maxLength && text.includes(' ') && el.children.length < 15) {
            maxLength = text.length;
            bestText = text;
          }
        });
        return bestText || document.body.innerText;
      });
    }

    if (!title || !description) {
      throw new Error('Failed to extract title or description from page.');
    }

    return {
      title: title.trim(),
      company: company.replace(/\n/g, ' ').trim(),
      url,
      description: description.trim(),
      poster: {
        name: posterName ? posterName.trim().replace(/\n/g, ' ') : '',
        title: posterTitle ? posterTitle.trim().replace(/\n/g, ' ') : '',
        url: posterUrl ? posterUrl.trim() : ''
      }
    };
  } catch (err) {
    logFn(`Playwright scraping failed: ${err.message}. Attempting fetch fallback...`, 'warning');
    try {
      const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      
      const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
      let title = titleMatch ? titleMatch[1].trim() : 'Unknown Title';
      title = title.split('|')[0].split('-')[0].trim();
      
      let cleanHtml = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
      cleanHtml = cleanHtml.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
      let text = cleanHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      
      return {
        title: title,
        company: 'Unknown Company',
        url,
        description: text,
        poster: { name: '', title: '', url: '' }
      };
    } catch (fetchErr) {
      throw new Error(`Both Playwright and Fetch fallbacks failed. Original: ${err.message}. Fetch: ${fetchErr.message}`);
    }
  } finally {
    await browser.close();
  }
}

// Browser launcher helper
async function launchScraperBrowser(config) {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-features=VizDisplayCompositor',
      '--disable-http2',
      '--disable-blink-features=AutomationControlled'
    ]
  };

  if (config && config.chromeExePath) {
    launchOptions.executablePath = config.chromeExePath;
  }

  const browser = await chromium.launch(launchOptions);
  return browser;
}

// LinkedIn Discovery Scraper
async function scrapeLinkedInJobs(page, keyword, location, logFn) {
  const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}`;
  logFn(`[LinkedIn] Navigating directly to: ${searchUrl}`, 'info');
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000); // Wait for the cards to render

  const rawJobs = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.base-card, .job-search-card, .base-search-card, .job-card-container, .jobs-search-results__list-item'));
    return cards.map(card => {
      const titleEl = card.querySelector('.base-search-card__title, .job-search-card__title, .job-card-list__title, .artdeco-entity-lockup__title');
      const companyEl = card.querySelector('.base-search-card__subtitle, .job-search-card__subtitle, .job-search-card__company-name, .job-card-container__company-name, .artdeco-entity-lockup__subtitle');
      const linkEl = card.querySelector('a.base-card__full-link, a.job-search-card__link, a.job-card-container__link, a.job-card-list__title');
      const locationEl = card.querySelector('.job-search-card__location, .base-search-card__metadata, .job-card-container__metadata-item');
      
      return {
        title: titleEl ? titleEl.innerText.trim() : '',
        company: companyEl ? companyEl.innerText.trim() : '',
        url: linkEl ? linkEl.href : '',
        location: locationEl ? locationEl.innerText.trim().replace(/\n/g, ' ') : ''
      };
    }).filter(j => j.url && j.title);
  });

  logFn(`[LinkedIn] Found ${rawJobs.length} potential job listings.`, 'info');
  return rawJobs;
}

// Indeed UAE Discovery Scraper
async function scrapeIndeedJobs(page, keyword, location, logFn) {
  // Use ae.indeed.com for UAE
  const searchUrl = `https://ae.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}`;
  logFn(`[Indeed UAE] Navigating directly to: ${searchUrl}`, 'info');
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000); // Wait for the cards to render

  const rawJobs = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.job_seen_beacon, .result'));
    return cards.map(card => {
      const titleEl = card.querySelector('.jcs-JobTitle span, h3.jobTitle a span');
      const companyEl = card.querySelector('[data-testid="company-name"]');
      const linkEl = card.querySelector('a.jcs-JobTitle, h3.jobTitle a');
      const locationEl = card.querySelector('[data-testid="text-location"]');
      
      const jk = linkEl ? linkEl.getAttribute('data-jk') || linkEl.id.replace('job_', '') : '';
      const url = jk ? `https://ae.indeed.com/viewjob?jk=${jk}` : (linkEl ? linkEl.href : '');
      
      return {
        title: titleEl ? titleEl.innerText.trim() : '',
        company: companyEl ? companyEl.innerText.trim() : '',
        url: url,
        location: locationEl ? locationEl.innerText.trim() : ''
      };
    }).filter(j => j.url && j.title);
  });

  logFn(`[Indeed UAE] Found ${rawJobs.length} potential job listings.`, 'info');
  return rawJobs;
}

// GulfTalent Discovery Scraper
async function scrapeGulfTalentJobs(page, keyword, location, logFn) {
  const searchUrl = `https://www.gulftalent.com/jobs/search?key=${encodeURIComponent(keyword)}`;
  logFn(`[GulfTalent] Navigating directly to: ${searchUrl}`, 'info');
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000); // Wait for the cards to render

  const rawJobs = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('tr[data-cy="job-result-row"]'));
    return cards.map(card => {
      const titleEl = card.querySelector('a[data-cy="job-link"]');
      const companyEl = card.querySelector('a[href*="/companies/"]');
      let locationText = '';
      
      const locationEl = card.querySelector('a[href*="/jobs/city/"], a[href*="/jobs/country/"], a[href*="/jobs/"]');
      if (locationEl && locationEl !== titleEl && locationEl !== companyEl) {
        locationText = locationEl.innerText.trim();
      } else {
        // Fallback parsing of row text: "Title \n Company \t Location \t Date"
        const parts = (card.innerText || '').split('\n');
        if (parts.length > 1) {
          const subParts = parts[1].split('\t');
          if (subParts.length > 1) {
            locationText = subParts[1].trim();
          }
        }
      }
      
      let jobUrl = titleEl ? titleEl.getAttribute('href') || '' : '';
      if (jobUrl && !jobUrl.startsWith('http')) {
        jobUrl = 'https://www.gulftalent.com' + jobUrl;
      }
      
      return {
        title: titleEl ? titleEl.innerText.trim() : '',
        company: companyEl ? companyEl.innerText.trim() : '',
        url: jobUrl,
        location: locationText
      };
    }).filter(j => j.url && j.title);
  });

  logFn(`[GulfTalent] Found ${rawJobs.length} potential job listings.`, 'info');
  return rawJobs;
}

// Google Jobs Discovery Scraper
async function scrapeGoogleJobs(page, keyword, location, logFn) {
  // Query with ibp=htl;jobs (encoded as %3B) for immersive view
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(keyword + ' ' + location)}&ibp=htl%3Bjobs&hl=en&gl=ae`;
  logFn(`[Google Jobs] Navigating directly to: ${searchUrl}`, 'info');
  
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000); // Wait for the cards to render

  // Step 1: Extract card-level data (title, company, location) from the job list
  const cardData = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('span.gmxZue'));
    return cards.map((card, index) => {
      const titleEl = card.querySelector('.tNxQIb');
      const companyEl = card.querySelector('.wHYlTd.MKCbgd.a3jPc');
      const locationEl = card.querySelector('.wHYlTd.FqK3wc.MKCbgd');
      return {
        index,
        title: titleEl ? titleEl.innerText.trim() : '',
        company: companyEl ? companyEl.innerText.trim() : '',
        location: locationEl ? locationEl.innerText.trim() : ''
      };
    }).filter(c => c.title);
  });

  logFn(`[Google Jobs] Found ${cardData.length} card entries. Clicking each to extract apply links...`, 'info');

  // Step 2: Click each card and extract the first apply link from the detail panel
  const rawJobs = [];
  const cardElements = page.locator('span.gmxZue');
  const cardCount = Math.min(await cardElements.count(), 10); // Cap at 10 cards
  let previousApplyLink = '';

  for (let i = 0; i < cardCount; i++) {
    try {
      await cardElements.nth(i).click({ timeout: 3000 });

      // Wait for the detail panel's apply link to change from the previous card
      let applyLink = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.waitForTimeout(500);
        applyLink = await page.evaluate(() => {
          const link = document.querySelector('a.brKmxb');
          return link ? link.href : '';
        });
        if (applyLink && applyLink !== previousApplyLink) break;
      }

      if (applyLink && applyLink !== previousApplyLink && cardData[i]) {
        rawJobs.push({
          title: cardData[i].title,
          company: cardData[i].company,
          url: applyLink,
          location: cardData[i].location
        });
        previousApplyLink = applyLink;
      }
    } catch (err) {
      // Skip cards that fail to click
    }
  }

  logFn(`[Google Jobs] Found ${rawJobs.length} potential job listings with apply links.`, 'info');
  return rawJobs;
}

// Helper for Apify LinkedIn scraper
async function scrapeLinkedInJobsApify(client, keyword, location, logFn) {
  logFn(`[Apify LinkedIn] Starting cloud LinkedIn job scrape for "${keyword}" in "${location}"...`, 'info');
  try {
    const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}`;
    const run = await client.actor('curious_coder/linkedin-jobs-scraper').call({
      urls: [searchUrl],
      limit: 15,
      proxyConfiguration: { useApifyProxy: true }
    });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    logFn(`[Apify LinkedIn] Retrieved ${items.length} job listings from cloud dataset.`, 'success');
    return items.map(item => ({
      title: item.title || '',
      company: item.companyName || item.company?.name || 'Unknown Company',
      url: item.jobUrl || item.url || '',
      location: item.location || '',
      description: item.description || ''
    }));
  } catch (err) {
    logFn(`[Apify LinkedIn] Cloud scraping failed: ${err.message}`, 'warning');
    return [];
  }
}

// Helper for Apify Indeed scraper
async function scrapeIndeedJobsApify(client, keyword, location, logFn) {
  logFn(`[Apify Indeed] Starting cloud Indeed job scrape for "${keyword}" in "${location}"...`, 'info');
  try {
    let countryCode = 'AE';
    const loc = location.toLowerCase();
    if (loc.includes('saudi') || loc.includes('riyadh') || loc.includes('jeddah') || loc.includes('ksa')) countryCode = 'SA';
    else if (loc.includes('qatar') || loc.includes('doha')) countryCode = 'QA';
    else if (loc.includes('oman') || loc.includes('muscat')) countryCode = 'OM';
    else if (loc.includes('bahrain') || loc.includes('manama')) countryCode = 'BH';
    else if (loc.includes('kuwait')) countryCode = 'KW';

    const run = await client.actor('misceres/indeed-scraper').call({
      position: keyword,
      location: location,
      country: countryCode,
      maxItems: 15,
      proxyConfiguration: { useApifyProxy: true }
    });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    logFn(`[Apify Indeed] Retrieved ${items.length} job listings from cloud dataset.`, 'success');
    return items.map(item => ({
      title: item.positionName || item.title || '',
      company: item.company || 'Unknown Company',
      url: item.url || '',
      location: item.location || '',
      description: item.description || ''
    }));
  } catch (err) {
    logFn(`[Apify Indeed] Cloud Indeed scraping failed: ${err.message}`, 'warning');
    return [];
  }
}

// Unified Bulk discovery using multiple Job search engines
async function scrapeJobs(keyword, location, config, logFn, existingUrlsInput = null, activeSource = null) {
  const srcLabel = activeSource ? activeSource.toUpperCase() : 'ALL';
  logFn(`Starting multi-source job discovery [Source: ${srcLabel}] for Keyword: "${keyword}", Location: "${location}"...`, 'info');

  let apifyJobs = [];
  let useApify = config.apifyEnabled && (config.apifyApiToken || process.env.APIFY_API_TOKEN);

  if (useApify) {
    logFn(`Apify cloud scraping is enabled. Running LinkedIn and Indeed searches in the cloud...`, 'info');
    try {
      const client = new ApifyClient({ token: config.apifyApiToken || process.env.APIFY_API_TOKEN });
      const [liJobs, indJobs] = await Promise.all([
        scrapeLinkedInJobsApify(client, keyword, location, logFn),
        scrapeIndeedJobsApify(client, keyword, location, logFn)
      ]);
      apifyJobs = [...liJobs, ...indJobs];
      logFn(`Apify cloud scraper returned ${apifyJobs.length} total jobs.`, 'success');
    } catch (err) {
      logFn(`Apify cloud scraper encountered an error: ${err.message}. Falling back to local scraping...`, 'warning');
      useApify = false;
    }
  }

  const browser = await launchScraperBrowser(config);
  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    locale: 'en-US'
  });

  const page = await context.newPage();

  // Block non-essential assets like images, fonts, and media
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  const results = [];

  try {
    // Read existing database to avoid scraping duplicate URLs
    let existingUrls = existingUrlsInput || new Set();
    if (!existingUrlsInput) {
      try {
        const sqliteDb = require('./db');
        const jobs = sqliteDb.getAllJobs();
        jobs.forEach(j => {
          if (j.url) existingUrls.add(j.url.toLowerCase().trim());
        });
      } catch (e) {
        logFn(`Could not read SQLite database for deduplication: ${e.message}`, 'warning');
      }
    }

    // 1. Crawl active source only (round-robin rotation)
    let allRawJobs = [];
    const src = activeSource || 'all';

    // Source A: LinkedIn (local Playwright)
    if (src === 'linkedin' || src === 'all') {
      try {
        const linkedinJobs = await scrapeLinkedInJobs(page, keyword, location, logFn);
        allRawJobs = allRawJobs.concat(linkedinJobs);
      } catch (err) {
        logFn(`LinkedIn local scraping failed: ${err.message}`, 'warning');
      }
    }

    // Source B: Indeed (local Playwright)
    if (src === 'indeed' || src === 'all') {
      try {
        const indeedJobs = await scrapeIndeedJobs(page, keyword, location, logFn);
        allRawJobs = allRawJobs.concat(indeedJobs);
      } catch (err) {
        logFn(`Indeed local scraping failed: ${err.message}`, 'warning');
      }
    }

    // Apify cloud boost: appended on top of LinkedIn or Indeed cycles when budget allows
    if (useApify && (src === 'linkedin' || src === 'indeed' || src === 'all')) {
      allRawJobs = allRawJobs.concat(apifyJobs);
    }

    // Source C: GulfTalent (local Playwright)
    if (src === 'gulftalent' || src === 'all') {
      try {
        const gtJobs = await scrapeGulfTalentJobs(page, keyword, location, logFn);
        allRawJobs = allRawJobs.concat(gtJobs);
      } catch (err) {
        logFn(`GulfTalent scraping failed: ${err.message}`, 'warning');
      }
    }

    // Source D: Google Jobs (local Playwright)
    if (src === 'google' || src === 'all') {
      try {
        const googleJobs = await scrapeGoogleJobs(page, keyword, location, logFn);
        allRawJobs = allRawJobs.concat(googleJobs);
      } catch (err) {
        logFn(`Google Jobs scraping failed: ${err.message}`, 'warning');
      }
    }

    logFn(`Aggregated ${allRawJobs.length} total potential job listings from all sources.`, 'info');

    // 2. Filter, deduplicate, and blacklist check
    const newJobs = [];
    const seenUrlsInThisBatch = new Set();

    for (const job of allRawJobs) {
      if (!job.url || typeof job.url !== 'string' || job.url.trim() === '') {
        continue;
      }
      const urlLower = job.url.toLowerCase().trim();
      const compLower = job.company.toLowerCase().trim();

      // Check unique in database
      if (existingUrls.has(urlLower)) {
        continue;
      }

      // Check unique in current search run
      if (seenUrlsInThisBatch.has(urlLower)) {
        continue;
      }
      seenUrlsInThisBatch.add(urlLower);

      // Check blacklist
      const isBlacklisted = config.blacklistCompanies.some(bc => 
        compLower.includes(bc.toLowerCase().trim()) || urlLower.includes(bc.toLowerCase().trim())
      );

      if (isBlacklisted) {
        logFn(`Skipping blacklisted company: ${job.company}`, 'warning');
        continue;
      }

      // Check gulf location
      const gulfLocations = config.gulfLocations || [];
      const jobLocationLower = (job.location || '').toLowerCase();
      const isGulfJob = gulfLocations.length === 0 || gulfLocations.some(g => jobLocationLower.includes(g.toLowerCase()));
      
      if (!isGulfJob) {
        logFn(`Skipping job outside Gulf: ${job.location} ("${job.title}")`, 'warning');
        continue;
      }

      newJobs.push(job);
    }

    logFn(`Found ${newJobs.length} new, unique, non-blacklisted jobs. Proceeding to scrape details for top jobs...`, 'info');

    // 3. Scrape details for the top jobs (up to quota limit)
    const limit = Math.min(newJobs.length, config.maxJobsScoredPerRun || 5);
    for (let i = 0; i < limit; i++) {
      const targetJob = newJobs[i];
      
      try {
        let details = null;
        if (targetJob.description) {
          logFn(`Job detail/description already retrieved for "${targetJob.title}" at ${targetJob.company}. Skipping detail page scrape.`, 'success');
          details = targetJob;
        } else {
          logFn(`Scraping detail page for job ${i + 1}/${limit}: "${targetJob.title}" at ${targetJob.company}...`, 'info');
          details = await scrapeJobUrl(targetJob.url, logFn, config);
        }

        if (details && details.description) {
          const job = {
            title: details.title || targetJob.title,
            company: details.company || targetJob.company,
            url: targetJob.url,
            location: details.location || targetJob.location,
            description: details.description,
            poster: details.poster || targetJob.poster || { name: '', title: '', url: '' },
            careerSiteUrl: '',
            hrEmail: ''
          };
          results.push(job);
          logFn(`Successfully retrieved details for "${details.title}" at ${details.company}`, 'success');

          // Asynchronously find HR contact info without blocking
          findHrDetails(job.company, logFn, config, job.poster?.url).then(hrDetails => {
            job.careerSiteUrl = hrDetails.careerSiteUrl || '';
            job.hrEmail = hrDetails.hrEmail || '';
            if (hrDetails.careerSiteUrl || hrDetails.hrEmail) {
              logFn(`[HR] Found details for ${job.company}: ${hrDetails.hrEmail || ''} ${hrDetails.careerSiteUrl || ''}`, 'info');
            }
          }).catch(() => {});
        } else {
          logFn(`Failed to extract description for "${targetJob.title}"`, 'warning');
        }
        
        await delay(3000 + Math.random() * 2000);
      } catch (err) {
        logFn(`Failed to scrape job detail page: ${err.message}`, 'warning');
      }
    }

    logFn(`Job discovery completed. Successfully scraped ${results.length} jobs.`, 'success');
  } catch (err) {
    logFn(`Job discovery failed: ${err.message}`, 'error');
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = {
  scrapeJobUrl,
  scrapeJobs
};
