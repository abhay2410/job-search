const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { findHrDetails } = require('./hr_finder');

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
async function scrapeJobUrl(url, logFn) {
  const userAgent = getRandomUserAgent();
  logFn(`Launching browser for single URL scrape (User-Agent: ...${userAgent.slice(-20)})...`, 'info');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-features=VizDisplayCompositor',
      '--disable-http2'
    ]
  });
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

// Bulk discovery using LinkedIn Job Search directly
async function scrapeJobs(keyword, location, config, logFn) {
  logFn(`Starting job discovery for Keyword: "${keyword}", Location: "${location}"...`, 'info');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-features=VizDisplayCompositor',
      '--disable-http2'
    ]
  });
  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    locale: 'en-US'
  });

  const page = await context.newPage();

  const results = [];

  try {
    // Read existing database to avoid scraping jobs we already have
    let existingUrls = new Set();
    try {
      const dbPath = path.join(__dirname, '..', 'database.json');
      if (fs.existsSync(dbPath)) {
        const dbData = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        if (dbData.jobs && Array.isArray(dbData.jobs)) {
          dbData.jobs.forEach(j => {
            if (j.url) existingUrls.add(j.url.toLowerCase().trim());
          });
        }
      }
    } catch (e) {
      logFn(`Could not read database.json for deduplication: ${e.message}`, 'warning');
    }

    const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}`;
    logFn(`Navigating directly to LinkedIn Job Search: ${searchUrl}`, 'info');
    
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

    logFn(`LinkedIn search returned ${rawJobs.length} potential job listings.`, 'info');

    if (rawJobs.length === 0) {
      logFn('No job cards found on LinkedIn. This could be due to rate-limiting or selector changes.', 'warning');
      try {
        await page.screenshot({ path: path.join(__dirname, '..', 'scratch', 'linkedin_error.jpg') });
        logFn('Saved screenshot to scratch/linkedin_error.jpg for debugging.', 'info');
      } catch (e) {}
      return [];
    }

    // Filter jobs (blacklist & duplicates)
    const newJobs = [];
    for (const job of rawJobs) {
      const urlLower = job.url.toLowerCase().trim();
      const compLower = job.company.toLowerCase().trim();

      // Check duplicate
      if (existingUrls.has(urlLower)) {
        continue;
      }

      // Check blacklist
      const isBlacklisted = config.blacklistCompanies.some(bc => 
        compLower.includes(bc.toLowerCase().trim()) || urlLower.includes(bc.toLowerCase().trim())
      );

      if (isBlacklisted) {
        logFn(`Skipping blacklisted company: ${job.company}`, 'warning');
        continue;
      }

      newJobs.push(job);
    }

    logFn(`Found ${newJobs.length} new, non-blacklisted jobs. Proceeding to scrape details for the top jobs...`, 'info');

    // Scrape details for up to 5 jobs (to prevent rate limits and keep it fast)
    const limit = Math.min(newJobs.length, 5);
    for (let i = 0; i < limit; i++) {
      const targetJob = newJobs[i];
      logFn(`Scraping detail page for job ${i + 1}/${limit}: "${targetJob.title}" at ${targetJob.company}...`, 'info');
      
      try {
        const details = await scrapeJobUrl(targetJob.url, logFn);
        if (details && details.description) {
          // Push job immediately — HR details are fetched in the background (non-blocking)
          const job = {
            title: details.title || targetJob.title,
            company: details.company || targetJob.company,
            url: targetJob.url,
            description: details.description,
            poster: details.poster,
            careerSiteUrl: '',
            hrEmail: ''
          };
          results.push(job);
          logFn(`Successfully scraped "${details.title}" at ${details.company}`, 'success');

          // Fire-and-forget: fetch HR details asynchronously without blocking the scraper
          findHrDetails(job.company, logFn).then(hrDetails => {
            job.careerSiteUrl = hrDetails.careerSiteUrl || '';
            job.hrEmail = hrDetails.hrEmail || '';
            if (hrDetails.careerSiteUrl || hrDetails.hrEmail) {
              logFn(`[HR] Found details for ${job.company}: ${hrDetails.hrEmail || ''} ${hrDetails.careerSiteUrl || ''}`, 'info');
            }
          }).catch(() => { /* HR search failed silently */ });
        } else {
          logFn(`Failed to extract description for "${targetJob.title}"`, 'warning');
        }
        
        // Wait between detail page requests to look human
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
