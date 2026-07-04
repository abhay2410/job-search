const path = require('path');
const fs = require('fs');
const scraper = require('./scraper');

// Load config
const configPath = path.join(__dirname, '..', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log('Successfully loaded config.json');
} catch (err) {
  console.error('Failed to load config.json, using defaults:', err.message);
}

// Override settings for fast testing: only scrape 1 job detail page per test
const testConfig = {
  ...config,
  maxJobsScoredPerRun: 1,
  blacklistCompanies: [] // clear blacklist to ensure we find jobs for testing
};

// Custom log function
const logFn = (msg, level = 'info') => {
  const prefix = {
    info: '[INFO]',
    success: '[SUCCESS]',
    warning: '[WARNING]',
    error: '[ERROR]',
    system: '[SYSTEM]'
  }[level] || '[INFO]';
  console.log(`${prefix} ${msg}`);
};

const keyword = 'Embedded Engineer';
const location = 'Dubai';

async function runTests() {
  console.log('==================================================');
  console.log(`Starting FAST Scraper Tests for: "${keyword}" in "${location}"`);
  console.log(' (Limit to 1 detail page scrape per source to prevent timeouts)');
  console.log('==================================================\n');

  // Test 1: Local GulfTalent
  console.log('--- TEST 1: GulfTalent (Local) ---');
  try {
    const results = await scraper.scrapeJobs(keyword, location, { ...testConfig, apifyEnabled: false }, logFn, null, 'gulftalent');
    console.log(`\nResult: Found ${results.length} jobs on GulfTalent.`);
    if (results.length > 0) {
      console.log('Sample:', results[0].title, '@', results[0].company, `(${results[0].url})`);
    }
  } catch (err) {
    console.error('GulfTalent test failed:', err.message);
  }
  console.log('\n--------------------------------------------------\n');

  // Test 2: Local Google Jobs
  console.log('--- TEST 2: Google Jobs (Local) ---');
  try {
    const results = await scraper.scrapeJobs(keyword, location, { ...testConfig, apifyEnabled: false }, logFn, null, 'google');
    console.log(`\nResult: Found ${results.length} jobs on Google Jobs.`);
    if (results.length > 0) {
      console.log('Sample:', results[0].title, '@', results[0].company, `(${results[0].url})`);
    }
  } catch (err) {
    console.error('Google Jobs test failed:', err.message);
  }
  console.log('\n--------------------------------------------------\n');

  // Test 3: Local Indeed
  console.log('--- TEST 3: Indeed (Local) ---');
  try {
    const results = await scraper.scrapeJobs(keyword, location, { ...testConfig, apifyEnabled: false }, logFn, null, 'indeed');
    console.log(`\nResult: Found ${results.length} jobs on Indeed.`);
    if (results.length > 0) {
      console.log('Sample:', results[0].title, '@', results[0].company, `(${results[0].url})`);
    }
  } catch (err) {
    console.error('Indeed test failed:', err.message);
  }
  console.log('\n--------------------------------------------------\n');

  // Test 4: Local LinkedIn
  console.log('--- TEST 4: LinkedIn (Local) ---');
  try {
    const results = await scraper.scrapeJobs(keyword, location, { ...testConfig, apifyEnabled: false }, logFn, null, 'linkedin');
    console.log(`\nResult: Found ${results.length} jobs on LinkedIn.`);
    if (results.length > 0) {
      console.log('Sample:', results[0].title, '@', results[0].company, `(${results[0].url})`);
    }
  } catch (err) {
    console.error('LinkedIn test failed:', err.message);
  }
  console.log('\n--------------------------------------------------\n');

  // Test 5: Apify Integration (LinkedIn + Indeed Cloud)
  console.log('--- TEST 5: Apify Cloud Boost (LinkedIn/Indeed) ---');
  if (!config.apifyApiToken && !process.env.APIFY_API_TOKEN) {
    console.log('[WARNING] Skipping Apify test: apifyApiToken is not set in config.json or environment.');
  } else {
    try {
      const results = await scraper.scrapeJobs(keyword, location, { ...testConfig, apifyEnabled: true }, logFn, null, 'linkedin');
      console.log(`\nResult: Found ${results.length} jobs on LinkedIn (with Apify Cloud Boost).`);
      if (results.length > 0) {
        console.log('Sample:', results[0].title, '@', results[0].company, `(${results[0].url})`);
      }
    } catch (err) {
      console.error('Apify test failed:', err.message);
    }
  }
  console.log('\n==================================================');
  console.log('Scraper testing completed.');
  console.log('==================================================');
}

runTests().catch(console.error);
