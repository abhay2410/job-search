/**
 * llmProvider.js – Unified LLM dispatcher with automatic fallback.
 *
 * Reads `llmPrimaryProvider` and `llmFallbackProvider` from config.json.
 * Tries the primary first; on failure switches to fallback transparently.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { return {}; }
}

function getProviderModule(name) {
  switch (name) {
    case 'nvidia':
      return require('./nvidiaProvider');
    case 'gemini':
    default:
      return require('./gemini');
  }
}

/**
 * Wraps every LLM function call: try primary → catch → try fallback.
 */
function createProxy(systemLog) {
  const config = readConfig();
  const primaryName   = config.llmPrimaryProvider  || 'gemini';
  const fallbackName  = config.llmFallbackProvider || 'local';

  const primary  = getProviderModule(primaryName);
  const fallback = getProviderModule(fallbackName);

  const METHODS = [
    'scoreJob',
    'analyzeJob',
    'tailorResume',
    'generateCoverLetter',
    'calculateConfidence',
    'generateColdEmail'
  ];

  const proxy = {};

  for (const method of METHODS) {
    proxy[method] = async function (...args) {
      // --- try primary ---
      try {
        if (typeof primary[method] === 'function') {
          const result = await primary[method](...args);
          return result;
        }
      } catch (err) {
        const msg = err.message || '';
        const isQuota = /429|503|quota|rate.?limit|overloaded|high demand/i.test(msg);
        if (systemLog) {
          systemLog(
            `[LLM] ${primaryName} failed (${isQuota ? 'quota/rate-limit' : 'error'}): ${msg.substring(0, 120)}. Falling back to ${fallbackName}...`,
            isQuota ? 'warning' : 'error'
          );
        }
        // Always fall through to fallback — don't re-throw here
      }

      // --- try fallback ---
      try {
        if (typeof fallback[method] === 'function') {
          const result = await fallback[method](...args);
          if (systemLog) {
            systemLog(`[LLM] ${fallbackName} handled "${method}" successfully.`, 'info');
          }
          return result;
        }
      } catch (err2) {
        if (systemLog) {
          systemLog(`[LLM] Fallback ${fallbackName} also failed: ${err2.message}`, 'error');
        }
        throw err2;
      }

      throw new Error(`No provider implements "${method}".`);
    };
  }

  return proxy;
}

module.exports = { createProxy, getProviderModule };
