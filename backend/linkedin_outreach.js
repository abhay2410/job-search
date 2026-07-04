/**
 * linkedin_outreach.js — LinkedIn Auto-Connect & Personalized DM
 * Sends connection requests (with a note) or DMs to job posters/recruiters.
 * Hard cap: 30 actions/day, enforced via database counter.
 * Uses the same persistent session as applier.js (user_data/).
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (minMs, maxMs) => delay(Math.floor(Math.random() * (maxMs - minMs)) + minMs);

const USER_DATA_DIR = path.join(__dirname, '..', 'user_data');
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

/**
 * Get today's connection count from the database object.
 * The counter resets automatically when the date changes.
 */
function getTodayConnectionCount(db) {
  const today = new Date().toISOString().split('T')[0];
  if (!db.linkedinOutreach) db.linkedinOutreach = {};
  if (db.linkedinOutreach.date !== today) {
    db.linkedinOutreach = { date: today, count: 0, sentTo: [] };
  }
  return db.linkedinOutreach.count || 0;
}

/**
 * Increment the daily connection counter in the database object (in-place).
 */
function incrementTodayCount(db, profileUrl) {
  const today = new Date().toISOString().split('T')[0];
  if (!db.linkedinOutreach) db.linkedinOutreach = {};
  if (db.linkedinOutreach.date !== today) {
    db.linkedinOutreach = { date: today, count: 0, sentTo: [] };
  }
  db.linkedinOutreach.count = (db.linkedinOutreach.count || 0) + 1;
  if (!db.linkedinOutreach.sentTo) db.linkedinOutreach.sentTo = [];
  db.linkedinOutreach.sentTo.push(profileUrl);
}

/**
 * Main outreach function: send a personalized LinkedIn connection request/DM.
 * @param {object} job - The job object from the database (must have poster.url)
 * @param {string} connectionMessage - The <=300 char personalized message
 * @param {object} db - The database object (will be mutated in-place for counter update)
 * @param {function} logFn - Logging function (msg, type)
 * @returns {{ success: boolean, action: string, message: string }}
 */
async function sendLinkedInConnect(job, connectionMessage, db, logFn) {
  const config = readConfig();
  const maxPerDay = config.linkedinMaxConnectionsPerDay || 30;

  const posterUrl = job.poster?.url;
  if (!posterUrl) {
    return { success: false, action: 'skipped', message: 'No poster LinkedIn URL available for this job.' };
  }

  // Clean the URL (remove tracking params)
  const cleanUrl = posterUrl.split('?')[0].replace(/\/$/, '');

  // Check if already sent to this person
  if (db.linkedinOutreach?.sentTo?.includes(cleanUrl)) {
    return { success: false, action: 'skipped', message: `Already sent connection request to ${cleanUrl}` };
  }

  // Daily limit check
  const todayCount = getTodayConnectionCount(db);
  if (todayCount >= maxPerDay) {
    return { success: false, action: 'rate_limited', message: `Daily limit of ${maxPerDay} connections reached. Resets tomorrow.` };
  }

  logFn(`[LinkedIn Outreach] Connecting to: ${job.poster?.name || 'Unknown'} (${cleanUrl})`, 'info');

  const launchOptions = {
    headless: false,
    slowMo: 80,
  };

  // Use Chrome executable if configured
  const possibleChromePaths = [
    config.chromeExePath,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const chromeExec = possibleChromePaths.find(p => p && fs.existsSync(p));
  if (chromeExec) {
    launchOptions.executablePath = chromeExec;
    logFn(`[LinkedIn Outreach] Using Chrome: ${chromeExec}`, 'info');
  }

  let context = null;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Navigate to the poster's LinkedIn profile
    logFn(`[LinkedIn Outreach] Navigating to profile: ${cleanUrl}`, 'info');
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(2000, 4000);

    // Check for LinkedIn login wall
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
      await context.close();
      return {
        success: false,
        action: 'login_required',
        message: 'LinkedIn login required. Please log in to LinkedIn via the dashboard "Launch Browser" button first.'
      };
    }

    // Check for CAPTCHA or unusual activity warning
    const captchaDetected = await page.$('form#captcha-challenge, .challenge-dialog, input[name="pin"]').catch(() => null);
    if (captchaDetected) {
      logFn('[LinkedIn Outreach] CAPTCHA detected — stopping to protect account.', 'warning');
      await context.close();
      return { success: false, action: 'captcha', message: 'LinkedIn CAPTCHA detected. Please solve it manually and retry.' };
    }

    // Try to find "Connect" button on the profile page
    logFn('[LinkedIn Outreach] Looking for Connect button...', 'info');
    await randomDelay(1500, 2500);

    const connectBtn = await page.$(
      'button:has-text("Connect"), .pvs-profile-actions button:has-text("Connect"), .pv-top-card-v2__cta-section button:has-text("Connect")'
    ).catch(() => null);

    if (connectBtn) {
      logFn('[LinkedIn Outreach] Found Connect button. Clicking...', 'info');
      await connectBtn.scrollIntoViewIfNeeded();
      await connectBtn.click();
      await randomDelay(1500, 2500);

      // Look for "Add a note" option in the connect dialog
      const addNoteBtn = await page.$('button:has-text("Add a note"), button[aria-label*="note"]').catch(() => null);
      if (addNoteBtn) {
        await addNoteBtn.click();
        await randomDelay(1000, 2000);

        // Type the personalized connection note (max 300 chars)
        const noteTextarea = await page.$('textarea#custom-message, textarea[name="message"], .send-invite__custom-message').catch(() => null);
        if (noteTextarea) {
          const truncatedNote = connectionMessage.substring(0, 300);
          await noteTextarea.click();
          await noteTextarea.fill(truncatedNote);
          await randomDelay(1000, 1500);
          logFn(`[LinkedIn Outreach] Note filled (${truncatedNote.length} chars)`, 'info');
        }
      }

      // Click Send invitation
      const sendBtn = await page.$(
        'button[aria-label="Send invitation"], button:has-text("Send"), button[aria-label*="Send now"]'
      ).catch(() => null);
      if (sendBtn) {
        await sendBtn.scrollIntoViewIfNeeded();
        await randomDelay(800, 1500);
        await sendBtn.click();
        await randomDelay(2000, 3500);
        logFn(`[LinkedIn Outreach] ✅ Connection request sent to ${job.poster?.name}!`, 'success');
        incrementTodayCount(db, cleanUrl);
        await context.close();
        return {
          success: true,
          action: 'connected',
          message: `Connection request sent to ${job.poster?.name || 'recruiter'} with personalized note.`
        };
      }
    }

    // Fallback: If already connected, look for Message button
    logFn('[LinkedIn Outreach] Connect not found. Checking for Message button (already connected?)...', 'info');
    const messageBtn = await page.$(
      'a:has-text("Message"), button:has-text("Message"), .pvs-profile-actions a:has-text("Message")'
    ).catch(() => null);

    if (messageBtn) {
      logFn('[LinkedIn Outreach] Found Message button. Sending DM...', 'info');
      await messageBtn.scrollIntoViewIfNeeded();
      await messageBtn.click();
      await randomDelay(2000, 3500);

      // Type in the message box
      const msgBox = await page.$(
        '.msg-form__contenteditable, div[contenteditable="true"][role="textbox"], .message-form__texteditor-box div[contenteditable]'
      ).catch(() => null);
      if (msgBox) {
        await msgBox.click();
        await msgBox.fill(connectionMessage.substring(0, 1900));
        await randomDelay(1000, 2000);

        const dmSendBtn = await page.$('button[type="submit"].msg-form__send-btn, button:has-text("Send")').catch(() => null);
        if (dmSendBtn) {
          await dmSendBtn.click();
          await randomDelay(2000, 3000);
          logFn(`[LinkedIn Outreach] ✅ DM sent to ${job.poster?.name}!`, 'success');
          incrementTodayCount(db, cleanUrl);
          await context.close();
          return {
            success: true,
            action: 'dm_sent',
            message: `DM sent to ${job.poster?.name || 'recruiter'} (already connected).`
          };
        }
      }
    }

    // Neither button found
    await context.close();
    return {
      success: false,
      action: 'no_button',
      message: 'Could not find Connect or Message button. LinkedIn layout may have changed or profile is restricted.'
    };

  } catch (err) {
    try { if (context) await context.close(); } catch (e) {}
    logFn(`[LinkedIn Outreach] Error: ${err.message}`, 'error');
    return { success: false, action: 'error', message: err.message };
  }
}

module.exports = { sendLinkedInConnect, getTodayConnectionCount };
