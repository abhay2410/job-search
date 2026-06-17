const { chromium } = require('playwright');
const path = require('path');

// Strict timeout wrapper
function withTimeout(promise, maxMs, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), maxMs))
  ]);
}

/**
 * Strategy 1: Directly visit the company's likely career URLs
 * (e.g. company.com/careers, company.com/jobs) and scrape for HR email
 */
async function scrapeCareerPageDirectly(companyName, logFn) {
  const cleaned = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const candidateDomains = [
    `${cleaned}.com`,
    `${cleaned}.ae`,
    `${cleaned}.co`,
  ];
  const careerPaths = ['/careers', '/jobs', '/work-with-us', '/join-us', '/en/careers'];

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    for (const domain of candidateDomains) {
      for (const careerPath of careerPaths) {
        const url = `https://www.${domain}${careerPath}`;
        try {
          const page = await context.newPage();
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 6000 });
          if (response && response.ok()) {
            // Page loaded! Scrape it for an email address
            const pageText = await page.evaluate(() => document.body.innerText || '');
            await page.close();
            const emailMatch = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
            const hrEmail = emailMatch
              ? emailMatch.find(e => !e.includes('sentry.io') && !e.includes('example.com') && !e.includes('google.com'))
              : '';
            logFn(`[HR] Found career page at ${url}`, 'success');
            await browser.close();
            return { careerSiteUrl: url, hrEmail: hrEmail || '' };
          }
          await page.close();
        } catch (e) {
          // This URL didn't work, try next
        }
      }
    }
    await browser.close();
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
  }
  return null;
}

/**
 * Strategy 2: Use Bing search (no CAPTCHA for Playwright) to find career page
 */
async function searchBing(query, logFn) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 8000
    });

    const results = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('#b_results li.b_algo').forEach(el => {
        const linkEl = el.querySelector('h2 a');
        const snipEl = el.querySelector('.b_caption p, .b_snippet, p');
        if (linkEl) {
          // Bing wraps every link in a /ck/a redirect — decode real URL from base64 u= param
          let href = linkEl.getAttribute('href') || '';
          if (href.includes('bing.com/ck/a')) {
            try {
              const uParam = href.match(/[?&]u=([^&]+)/);
              if (uParam) {
                const encoded = uParam[1].substring(2); // strip "a1" prefix
                href = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
              }
            } catch (e) { /* keep original href if decode fails */ }
          }
          const title = linkEl.textContent || linkEl.innerText || '';
          const snippet = snipEl ? (snipEl.textContent || snipEl.innerText || '') : '';
          // Only keep results that decoded to a real external URL
          if (href && !href.startsWith('https://www.bing.com')) {
            items.push({ link: href, title: title.trim(), snippet: snippet.trim() });
          }
        }
      });
      return items;
    });

    await browser.close();
    return results || [];
  } catch (err) {
    if (browser) await browser.close().catch(() => { });
    logFn(`[HR] Bing search error: ${err.message}`, 'warning');
    return [];
  }
}

async function lookupHunterIo(domain, logFn) {
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '..', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const apiKey = config.hunterApiKey;
    if (!apiKey) return null;

    logFn(`[HR] Querying Hunter.io for emails at ${domain}...`, 'info');
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&api_key=${apiKey}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Hunter.io API error: ${response.status}`);
    const data = await response.json();

    if (data.errors) {
      logFn(`[HR] Hunter.io error: ${JSON.stringify(data.errors)}`, 'warning');
      return null;
    }

    const emails = data.data?.emails || [];
    if (emails.length === 0) return null;

    // Prefer HR/recruiting/talent/careers emails first
    const hrKeywords = ['hr', 'recruit', 'talent', 'career', 'people', 'hiring'];
    const hrEmail = emails.find(e =>
      hrKeywords.some(kw =>
        (e.value || '').toLowerCase().includes(kw) ||
        (e.department || '').toLowerCase().includes('human resources') ||
        (e.position || '').toLowerCase().includes(kw)
      )
    ) || emails[0];

    const emailStr = hrEmail.value;
    const name = [hrEmail.first_name, hrEmail.last_name].filter(Boolean).join(' ');
    const position = hrEmail.position || '';
    logFn(`[HR] Hunter.io found: ${emailStr}${name ? ` (${name}${position ? ', ' + position : ''})` : ''}`, 'success');
    return { email: emailStr, name, position };
  } catch (err) {
    logFn(`[HR] Hunter.io lookup failed: ${err.message}`, 'warning');
    return null;
  }
}

async function findHrDetails(companyName, logFn = console.log) {
  logFn(`[HR] Looking up career page & HR email for "${companyName}"...`, 'info');

  const result = await withTimeout((async () => {
    let careerSiteUrl = '';
    let hrEmail = '';
    let hrName = '';
    let hrPosition = '';

    // Strategy 1: Try direct career page URLs (fastest, most reliable)
    const direct = await withTimeout(
      scrapeCareerPageDirectly(companyName, logFn),
      12000,
      null
    );
    if (direct && direct.careerSiteUrl) {
      careerSiteUrl = direct.careerSiteUrl;
      hrEmail = direct.hrEmail || '';
    }

    // Strategy 2: Bing search if direct failed
    if (!careerSiteUrl) {
      try {
        const careerResults = await withTimeout(
          searchBing(`${companyName} official careers jobs apply`, logFn),
          10000,
          []
        );
        if (careerResults.length > 0) {
          // Filter out irrelevant results — URL must somewhat relate to company name
          const companyWords = companyName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          const relevant = careerResults.filter(r =>
            r.link &&
            !r.link.includes('linkedin.com') &&
            !r.link.includes('indeed.com') &&
            !r.link.includes('glassdoor.com') &&
            !r.link.includes('bing.com') &&
            !r.link.includes('google.com') &&
            !r.link.includes('wikipedia.org') &&
            (companyWords.length === 0 || companyWords.some(w => r.link.toLowerCase().includes(w) || r.title.toLowerCase().includes(w)))
          );
          const best = relevant;
          if (best.length > 0) {
            careerSiteUrl = best[0].link;
            logFn(`[HR] Found career site via Bing: ${careerSiteUrl}`, 'success');
          }

          // Check snippets for email addresses
          if (!hrEmail) {
            for (const res of careerResults) {
              const text = `${res.snippet} ${res.title}`;
              const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
              if (emailMatch &&
                !emailMatch[0].includes('sentry.io') &&
                !emailMatch[0].includes('example.com') &&
                !emailMatch[0].includes('bing.com')) {
                hrEmail = emailMatch[0];
                logFn(`[HR] Found HR email via Bing: ${hrEmail}`, 'success');
                break;
              }
            }
          }
        }
      } catch (err) {
        logFn(`[HR] Bing search failed: ${err.message}`, 'warning');
      }
    }

    // Strategy 3: Hunter.io — find real recruiter emails by company domain
    if (!hrEmail && careerSiteUrl) {
      try {
        const urlObj = new URL(careerSiteUrl);
        const domain = urlObj.hostname.replace(/^www\./, '');
        const hunterResult = await withTimeout(lookupHunterIo(domain, logFn), 10000, null);
        if (hunterResult) {
          hrEmail = hunterResult.email;
          hrName = hunterResult.name;
          hrPosition = hunterResult.position;
        }
      } catch (e) { /* invalid URL, skip */ }
    }

    return { careerSiteUrl, hrEmail, hrName, hrPosition };
  })(), 35000, { careerSiteUrl: '', hrEmail: '', hrName: '', hrPosition: '' });

  return result;
}

module.exports = { findHrDetails };
