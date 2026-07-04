/**
 * llmProvider.js – Unified LLM dispatcher with automatic fallback.
 *
 * Reads `llmPrimaryProvider` and `llmFallbackProvider` from config.json.
 * Tries the primary first; on failure switches to fallback transparently.
 */

const fs = require('fs');
const path = require('path');
const { BUZZWORDS } = require('./humanization_prompts');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const providerCooldowns = {};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { return {}; }
}

function getProviderModule(name) {
  switch (name) {
    case 'nvidia':
      return require('./nvidiaProvider');
    case 'openrouter':
      return require('./openrouterProvider');
    case 'gemini':
    default:
      return require('./gemini');
  }
}

/**
 * Wraps every LLM function call: tries primary -> fallback -> tertiary in sequence.
 */
function createProxy(systemLog, overridePrimaryName) {
  const config = readConfig();
  const primaryName   = overridePrimaryName || config.llmPrimaryProvider  || 'gemini';
  const fallbackName  = config.llmFallbackProvider || 'nvidia';
  const tertiaryName  = config.llmTertiaryProvider || 'openrouter';

  const METHODS = [
    'scoreJob',
    'analyzeJob',
    'tailorResume',
    'generateCoverLetter',
    'calculateConfidence',
    'generateColdEmail',
    'generateConnectionMessage',
    'answerFormQuestion'
  ];

  const proxy = {};

  for (const method of METHODS) {
    proxy[method] = async function (...args) {
      const now = Date.now();
      const providers = [
        { name: primaryName, mod: getProviderModule(primaryName) },
        { name: fallbackName, mod: getProviderModule(fallbackName) },
        { name: tertiaryName, mod: getProviderModule(tertiaryName) }
      ].filter(p => p.mod && (!providerCooldowns[p.name] || now > providerCooldowns[p.name]));

      let lastError = null;

      for (const provider of providers) {
        try {
          if (typeof provider.mod[method] === 'function') {
            let result = await provider.mod[method](...args);
            
            // Clean up any residual AI markers/buzzwords in generated content
            if (['tailorResume', 'generateCoverLetter', 'generateColdEmail', 'generateConnectionMessage'].includes(method) && typeof result === 'string') {
              result = humanizeCleanup(result);
            }
            
            return result;
          }
        } catch (err) {
          lastError = err;
          const msg = err.message || '';
          const isQuota = /429|503|quota|rate.?limit|overloaded|high demand/i.test(msg);
          if (isQuota) {
            // Put provider on a 15-minute cooldown
            providerCooldowns[provider.name] = Date.now() + 15 * 60 * 1000;
          }
          if (systemLog) {
            systemLog(
              `[LLM] ${provider.name} failed (${isQuota ? 'quota/rate-limit. Cooldown applied' : 'error'}): ${msg.substring(0, 120)}. Trying next fallback...`,
              isQuota ? 'warning' : 'error'
            );
          }
        }
      }

      throw new Error(`All LLM providers failed for "${method}". Last error: ${lastError ? lastError.message : 'No provider implemented method'}`);
    };
  }

  return proxy;
}

function humanizeCleanup(text) {
  if (!text || typeof text !== 'string') return text;

  let clean = text;

  // Dictionary of buzzwords and simpler human replacements
  const replacements = [
    // Resume filler adjectives
    { pattern: /\bHighly skilled\b/g, replacement: 'Experienced' },
    { pattern: /\bhighly skilled\b/g, replacement: 'experienced' },
    { pattern: /\bProven expertise\b/g, replacement: 'Experience' },
    { pattern: /\bproven expertise\b/g, replacement: 'experience' },
    { pattern: /\bproven track record\b/gi, replacement: 'track record' },
    { pattern: /\bResults-driven\b/g, replacement: 'Practical' },
    { pattern: /\bresults-driven\b/g, replacement: 'practical' },
    { pattern: /\bResults driven\b/g, replacement: 'Practical' },
    { pattern: /\bdriven engineer\b/gi, replacement: 'engineer' },
    { pattern: /\bseasoned professional\b/gi, replacement: 'professional' },
    { pattern: /\bseasoned engineer\b/gi, replacement: 'engineer' },
    { pattern: /\bexceptional skills\b/gi, replacement: 'skills' },
    { pattern: /\bhands-on experience\b/gi, replacement: 'experience' },
    { pattern: /\bhands on experience\b/gi, replacement: 'experience' },
    // Structural AI patterns
    { pattern: /\bStreamlining\b/g, replacement: 'Improving' },
    { pattern: /\bstreamlining\b/g, replacement: 'improving' },
    { pattern: /\bStreamlined\b/g, replacement: 'Improved' },
    { pattern: /\bstreamlined\b/g, replacement: 'improved' },
    { pattern: /\bscalable\b/gi, replacement: 'reliable' },
    { pattern: /\bseamlessly\b/gi, replacement: 'well' },
    { pattern: /\bseamless\b/gi, replacement: 'smooth' },
    { pattern: /\brobust\b/gi, replacement: 'solid' },
    { pattern: /\bcutting-edge\b/gi, replacement: 'modern' },
    { pattern: /\bcutting edge\b/gi, replacement: 'modern' },
    { pattern: /\binnovative\b/gi, replacement: 'new' },
    { pattern: /\bdelve\b/gi, replacement: 'go' },
    { pattern: /\btestament\b/gi, replacement: 'proof' },
    { pattern: /\bbeacon\b/gi, replacement: 'example' },
    { pattern: /\bsynergy\b/gi, replacement: 'collaboration' },
    { pattern: /\butilize\b/gi, replacement: 'use' },
    { pattern: /\butilizing\b/gi, replacement: 'using' },
    { pattern: /\bUtilized\b/g, replacement: 'Used' },
    { pattern: /\butilized\b/g, replacement: 'used' },
    { pattern: /\bleverage\b/gi, replacement: 'use' },
    { pattern: /\bleveraged\b/gi, replacement: 'used' },
    { pattern: /\bleveraging\b/gi, replacement: 'using' },
    { pattern: /\bspearheaded\b/gi, replacement: 'led' },
    { pattern: /\bspearhead\b/gi, replacement: 'lead' },
    { pattern: /\bgroundbreaking\b/gi, replacement: 'modern' },
    { pattern: /\btransformative\b/gi, replacement: 'impactful' },
    { pattern: /\belevate\b/gi, replacement: 'improve' },
    { pattern: /\bfoster\b/gi, replacement: 'build' },
    // Cover letter / email cliches
    { pattern: /\bexcited to apply\b/gi, replacement: 'applying' },
    { pattern: /\bexcited about the prospect of joining\b/gi, replacement: 'interested in joining' },
    { pattern: /\bI'm excited about the opportunity\b/gi, replacement: "I'm interested in the role" },
    { pattern: /\bI am excited about the opportunity\b/gi, replacement: "I'm interested in the role" },
    { pattern: /\bwriting to express my interest\b/gi, replacement: 'reaching out' },
    { pattern: /\bwrite to express my interest\b/gi, replacement: 'reach out' },
    { pattern: /\bhope this email finds you well\b/gi, replacement: '' },
    { pattern: /\bhope this finds you well\b/gi, replacement: '' },
    { pattern: /\bexact match\b/gi, replacement: 'good fit' },
    { pattern: /\baligns perfectly\b/gi, replacement: 'aligns well' },
    { pattern: /\bperfect fit\b/gi, replacement: 'strong match' },
    { pattern: /\bI'm confident in my ability\b/gi, replacement: "I'm comfortable" },
    { pattern: /\bI am confident in my ability\b/gi, replacement: "I'm comfortable" },
    { pattern: /\bI'm confident that my skills\b/gi, replacement: "My skills" },
    { pattern: /\bI am confident that my skills\b/gi, replacement: "My skills" },
    { pattern: /\bI'm confident that\b/gi, replacement: "I'm sure" },
    { pattern: /\bI believe I can contribute\b/gi, replacement: "I can contribute" },
    { pattern: /\bI'd love to discuss my qualifications further\b/gi, replacement: "happy to chat" },
    { pattern: /\bI would love to discuss my qualifications\b/gi, replacement: "happy to chat about my background" },
    { pattern: /\brevolutionize\b/gi, replacement: 'change' },
    { pattern: /\bempower\b/gi, replacement: 'help' },
    // Cover letter tone cliches
    { pattern: /\bstartup spirit\b/gi, replacement: 'approach' },
    { pattern: /\bdrive innovation\b/gi, replacement: 'improve the work' },
    { pattern: /\bdriving innovation\b/gi, replacement: 'improving the work' },
    { pattern: /\bI'm particularly drawn to\b/gi, replacement: "I like" },
    { pattern: /\bI am particularly drawn to\b/gi, replacement: "I like" },
    { pattern: /\bmake a meaningful impact\b/gi, replacement: 'contribute' },
    { pattern: /\bmaking a meaningful impact\b/gi, replacement: 'contributing' },
    { pattern: /\bexplore how my skills can contribute\b/gi, replacement: 'discuss how I can help' },
    { pattern: /\bhow my skills can contribute to the company's growth\b/gi, replacement: 'what I can bring' },
    { pattern: /\bcontribute to (?:the )?company's growth\b/gi, replacement: 'help the company' },
    { pattern: /\bcontribute to your (?:team's )?success\b/gi, replacement: 'help your team' },
    { pattern: /\bI'd love to discuss\b/gi, replacement: "Happy to chat" },
    { pattern: /\bI would love to discuss\b/gi, replacement: "Happy to chat" },
    { pattern: /\ba range of applications\b/gi, replacement: 'various embedded systems' },
    // Missing buzzwords from humanization_prompts.js
    { pattern: /\borchestrated\b/gi, replacement: 'handled' },
    { pattern: /\borchestrate\b/gi, replacement: 'handle' },
    { pattern: /\bresults-oriented professional\b/gi, replacement: 'professional' },
    { pattern: /\bresults-oriented\b/gi, replacement: 'practical' },
    { pattern: /\bdynamic\b/gi, replacement: 'active' },
    { pattern: /\bpassionate about\b/gi, replacement: 'interested in' },
    { pattern: /\bfast-paced environment\b/gi, replacement: 'demanding environment' },
    { pattern: /\bteam player\b/gi, replacement: 'collaborator' },
    { pattern: /\bdetail-oriented\b/gi, replacement: 'attentive' },
    { pattern: /\bgo-getter\b/gi, replacement: 'proactive' },
    { pattern: /\bhit the ground running\b/gi, replacement: 'start immediately' },
    { pattern: /\bwear many hats\b/gi, replacement: 'handle diverse tasks' },
    { pattern: /\bthink outside the box\b/gi, replacement: 'solve problems' },
    { pattern: /\bvalue-add\b/gi, replacement: 'value' },
    { pattern: /\bcircle back\b/gi, replacement: 'follow up' },
    { pattern: /\btouch base\b/gi, replacement: 'connect' },
    { pattern: /\blow-hanging fruit\b/gi, replacement: 'easy tasks' },
    { pattern: /\bmove the needle\b/gi, replacement: 'make progress' },
    { pattern: /\bholistic\b/gi, replacement: 'complete' },
    { pattern: /\btoday's fast-paced\b/gi, replacement: 'demanding' }
  ];

  // Protect Grapes Innovative Solutions
  const placeholder = "___GRAPES_INNOVATIVE_SOLUTIONS___";
  clean = clean.replace(/Grapes Innovative Solutions/gi, placeholder);

  // Apply replacements
  for (const item of replacements) {
    clean = clean.replace(item.pattern, item.replacement);
  }

  // Restore Grapes Innovative Solutions
  clean = clean.replace(new RegExp(placeholder, 'g'), "Grapes Innovative Solutions");

  // Clean double spaces and normalize carriage returns
  clean = clean.replace(/[ \t]+/g, ' ');
  clean = clean.replace(/\r\n/g, '\n');
  clean = clean.replace(/\n\s*\n\s*\n+/g, '\n\n');
  clean = clean.replace(/ ,/g, ',').replace(/ \./g, '.');

  return clean.trim();
}

module.exports = { createProxy, getProviderModule };
