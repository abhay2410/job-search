const { applyToJob } = require('./applier');

const mockJob = {
  id: 'job_test_sandbox',
  title: 'Sandbox Software Engineer',
  company: 'Sandbox Inc.',
  url: 'http://localhost:5000/sandbox',
  tailoredResume: 'JOHN DOE RESUME\nSkills: React, Node.js\nExperience:\n- Built React and Node applications.',
  coverLetter: 'This is my cover letter for Sandbox Inc.',
  confidence: 90
};

const mockConfig = {
  masterResume: 'JOHN DOE RESUME\nSkills: React, Node.js\nExperience:\n- Built React and Node applications.',
  workAuthorization: 'US Citizen',
  locations: ['Remote'],
  remotePreference: 'remote'
};

console.log('Starting sandbox applier test...');
applyToJob(mockJob, mockConfig, (msg, type) => {
  console.log(`[TEST LOG][${type.toUpperCase()}] ${msg}`);
})
  .then(result => {
    console.log('TEST RESULT:', result);
    process.exit(result.success ? 0 : 1);
  })
  .catch(err => {
    console.error('TEST ERROR:', err);
    process.exit(1);
  });
