import React, { useState, useEffect } from 'react';

export default function ProfileConfig() {
  const [config, setConfig] = useState({
    masterResume: '',
    targetRoles: [],
    locations: [],
    remotePreference: 'any',
    salaryFloor: '',
    blacklistCompanies: [],
    workAuthorization: '',
    geminiApiKey: '',
    googleSheetsUrl: '',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
    hunterApiKey: '',
    senderEmail: '',
    useLocalChromeProfile: false,
    chromeProfileName: 'Default',
    autoApplyEnabled: true,
    maxJobsAppliedPerRun: 5,
    discordWebhookUrl: '',
    enableEmailAlerts: false
  });

  const [rolesStr, setRolesStr] = useState('');
  const [locationsStr, setLocationsStr] = useState('');
  const [blacklistStr, setBlacklistStr] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: '', type: '' });

  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => {
        setConfig(prev => ({
          ...prev,
          ...data,
          salaryFloor: data.salaryFloor || '',
          smtpPort: data.smtpPort || 587,
          smtpSecure: data.smtpSecure || false,
          useLocalChromeProfile: data.useLocalChromeProfile || false,
          chromeProfileName: data.chromeProfileName || 'Default',
          autoApplyEnabled: data.autoApplyEnabled !== false,
          maxJobsAppliedPerRun: data.maxJobsAppliedPerRun || 5,
          discordWebhookUrl: data.discordWebhookUrl || '',
          enableEmailAlerts: data.enableEmailAlerts || false
        }));
        setRolesStr((data.targetRoles || []).join(', '));
        setLocationsStr((data.locations || []).join(', '));
        setBlacklistStr((data.blacklistCompanies || []).join(', '));
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load config:', err);
        setLoading(false);
      });
  }, []);

  const [browserLaunching, setBrowserLaunching] = useState(false);
  const [browserStatus, setBrowserStatus] = useState('');

  const launchAutomationBrowser = async () => {
    setBrowserLaunching(true);
    setBrowserStatus('Launching browser...');
    try {
      const res = await fetch('/api/browser/launch', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setBrowserStatus('Launched! Log in and close browser window.');
      } else {
        setBrowserStatus('Error launching browser: ' + data.message);
      }
    } catch (err) {
      setBrowserStatus('Error launching browser.');
    } finally {
      setBrowserLaunching(false);
    }
  };

  const handleSave = (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage({ text: '', type: '' });

    const payload = {
      ...config,
      targetRoles: rolesStr.split(',').map(r => r.trim()).filter(Boolean),
      locations: locationsStr.split(',').map(l => l.trim()).filter(Boolean),
      blacklistCompanies: blacklistStr.split(',').map(b => b.trim()).filter(Boolean),
      salaryFloor: config.salaryFloor ? Number(config.salaryFloor) : null,
      smtpPort: config.smtpPort ? Number(config.smtpPort) : 587,
      smtpSecure: Boolean(config.smtpSecure),
      useLocalChromeProfile: Boolean(config.useLocalChromeProfile),
      chromeProfileName: config.chromeProfileName || 'Default',
      autoApplyEnabled: Boolean(config.autoApplyEnabled),
      maxJobsAppliedPerRun: config.maxJobsAppliedPerRun ? Number(config.maxJobsAppliedPerRun) : 5,
      discordWebhookUrl: config.discordWebhookUrl || '',
      enableEmailAlerts: Boolean(config.enableEmailAlerts),
      hunterApiKey: config.hunterApiKey || ''
    };

    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(data => {
        setSaving(false);
        if (data.success) {
          setMessage({ text: 'Profile saved successfully!', type: 'success' });
        } else {
          setMessage({ text: 'Failed to save configuration.', type: 'error' });
        }
      })
      .catch(err => {
        setSaving(false);
        setMessage({ text: `Error: ${err.message}`, type: 'error' });
      });
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '2rem' }}>Loading user profile...</div>;
  }

  return (
    <div className="glass-card" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <h2 style={{ marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }} className="title-gradient">
        User Profile & Preferences
      </h2>

      {message.text && (
        <div className={`alert alert-${message.type === 'error' ? 'danger' : 'success'}`}>
          {message.text}
        </div>
      )}

      <form onSubmit={handleSave}>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="geminiApiKey">Gemini API Key</label>
            <input
              type="password"
              id="geminiApiKey"
              value={config.geminiApiKey}
              onChange={e => setConfig({ ...config, geminiApiKey: e.target.value })}
              placeholder="AIzaSy..."
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="googleSheetsUrl">Google Sheets Apps Script URL (Optional)</label>
            <input
              type="text"
              id="googleSheetsUrl"
              value={config.googleSheetsUrl || ''}
              onChange={e => setConfig({ ...config, googleSheetsUrl: e.target.value })}
              placeholder="https://script.google.com/macros/s/.../exec"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="targetRoles">Target Job Titles (comma separated)</label>
            <input
              type="text"
              id="targetRoles"
              value={rolesStr}
              onChange={e => setRolesStr(e.target.value)}
              placeholder="Software Engineer, React Developer"
            />
          </div>
          <div className="form-group">
            <label htmlFor="workAuth">Work Authorization Status</label>
            <input
              type="text"
              id="workAuth"
              value={config.workAuthorization}
              onChange={e => setConfig({ ...config, workAuthorization: e.target.value })}
              placeholder="US Citizen, Green Card, Needs Sponsorship"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="locations">Location Preferences (comma separated)</label>
            <input
              type="text"
              id="locations"
              value={locationsStr}
              onChange={e => setLocationsStr(e.target.value)}
              placeholder="San Francisco, New York, Seattle"
            />
          </div>
          <div className="form-group">
            <label htmlFor="remotePref">Remote Preference</label>
            <select
              id="remotePref"
              value={config.remotePreference}
              onChange={e => setConfig({ ...config, remotePreference: e.target.value })}
            >
              <option value="remote">Remote Only</option>
              <option value="hybrid">Hybrid Allowed</option>
              <option value="onsite">On-Site Only</option>
              <option value="any">No Preference (Any)</option>
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="salaryFloor">Salary Floor (Annual, optional)</label>
            <input
              type="number"
              id="salaryFloor"
              value={config.salaryFloor}
              onChange={e => setConfig({ ...config, salaryFloor: e.target.value })}
              placeholder="120000"
            />
          </div>
          <div className="form-group">
            <label htmlFor="blacklist">Blacklisted Companies (comma separated)</label>
            <input
              type="text"
              id="blacklist"
              value={blacklistStr}
              onChange={e => setBlacklistStr(e.target.value)}
              placeholder="Meta, Apple"
            />
          </div>
        </div>

        <h3 style={{ marginTop: '2rem', marginBottom: '1rem', color: '#a5b4fc', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.25rem' }}>
          Cold Email SMTP Server Setup
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          Configure your personal outgoing mail server to send cold outreach recruiter emails directly. For Gmail, use host <code>smtp.gmail.com</code>, port <code>587</code> (TLS), and generate a 16-character App Password under Google Account Security.
        </p>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="smtpHost">SMTP Server Host</label>
            <input
              type="text"
              id="smtpHost"
              value={config.smtpHost || ''}
              onChange={e => setConfig({ ...config, smtpHost: e.target.value })}
              placeholder="smtp.gmail.com or mail.privateemail.com"
            />
          </div>
          <div className="form-group" style={{ maxWidth: '120px' }}>
            <label htmlFor="smtpPort">SMTP Port</label>
            <input
              type="number"
              id="smtpPort"
              value={config.smtpPort || ''}
              onChange={e => setConfig({ ...config, smtpPort: e.target.value })}
              placeholder="587"
            />
          </div>
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1.8rem' }}>
            <input
              type="checkbox"
              id="smtpSecure"
              checked={!!config.smtpSecure}
              onChange={e => setConfig({ ...config, smtpSecure: e.target.checked })}
              style={{ width: '18px', height: '18px', margin: 0 }}
            />
            <label htmlFor="smtpSecure" style={{ margin: 0 }}>Use SSL/Secure (Port 465)</label>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="smtpUser">SMTP User / Username</label>
            <input
              type="text"
              id="smtpUser"
              value={config.smtpUser || ''}
              onChange={e => setConfig({ ...config, smtpUser: e.target.value })}
              placeholder="your-email@gmail.com"
            />
          </div>
          <div className="form-group">
            <label htmlFor="smtpPass">SMTP Password / App Password</label>
            <input
              type="password"
              id="smtpPass"
              value={config.smtpPass || ''}
              onChange={e => setConfig({ ...config, smtpPass: e.target.value })}
              placeholder="••••••••••••••••"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="senderEmail">Sender Email Address</label>
            <input
              type="email"
              id="senderEmail"
              value={config.senderEmail || ''}
              onChange={e => setConfig({ ...config, senderEmail: e.target.value })}
              placeholder="your-name@gmail.com (must match authorized sender)"
            />
          </div>
        </div>

        <h3 style={{ marginTop: '2rem', marginBottom: '1rem', color: '#34d399', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.25rem' }}>
          🎯 Hunter.io — Real HR Recruiter Emails
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          Hunter.io finds real recruiter and HR email addresses by company domain.
          Free plan = 25 lookups/month. <a href="https://hunter.io/users/sign_up" target="_blank" rel="noreferrer" style={{ color: '#34d399' }}>Sign up free →</a>
        </p>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="hunterApiKey">Hunter.io API Key</label>
            <input
              type="password"
              id="hunterApiKey"
              value={config.hunterApiKey || ''}
              onChange={e => setConfig({ ...config, hunterApiKey: e.target.value })}
              placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', display: 'block' }}>
              Pipeline will automatically query Hunter.io for real recruiter emails after finding each company's career page.
            </span>
          </div>
        </div>

        <h3 style={{ marginTop: '2rem', marginBottom: '1rem', color: '#a5b4fc', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.25rem' }}>
          🤖 Auto-Apply Settings
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          When enabled, jobs that pass scoring and analysis (confidence ≥ 80%) are submitted automatically every 4 hours. The system applies a 30-application/day hard limit and a human-like 30-second delay between submissions.
        </p>
        <div className="form-row">
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
            <input
              type="checkbox"
              id="autoApplyEnabled"
              checked={!!config.autoApplyEnabled}
              onChange={e => setConfig({ ...config, autoApplyEnabled: e.target.checked })}
              style={{ width: '18px', height: '18px', margin: 0 }}
            />
            <label htmlFor="autoApplyEnabled" style={{ margin: 0 }}>
              ✅ Enable fully autonomous auto-apply (fills form + submits automatically)
            </label>
          </div>
          <div className="form-group" style={{ maxWidth: '180px' }}>
            <label htmlFor="maxJobsAppliedPerRun">Max applications per cycle</label>
            <input
              type="number"
              id="maxJobsAppliedPerRun"
              min="1"
              max="30"
              value={config.maxJobsAppliedPerRun || 5}
              onChange={e => setConfig({ ...config, maxJobsAppliedPerRun: e.target.value })}
            />
          </div>
        </div>

        <h3 style={{ marginTop: '2rem', marginBottom: '1rem', color: '#a5b4fc', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.25rem' }}>
          📱 Notification Alerts (Discord & Email)
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          Get instant alerts when a job matches or requires manual review. Email alerts will use the SMTP settings configured above and will automatically attach the generated PDF Cover Letter and Resume.
        </p>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="discordWebhookUrl">Discord Webhook URL</label>
            <input
              type="password"
              id="discordWebhookUrl"
              value={config.discordWebhookUrl || ''}
              onChange={e => setConfig({ ...config, discordWebhookUrl: e.target.value })}
              placeholder="https://discord.com/api/webhooks/..."
            />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            <input
              type="checkbox"
              id="enableEmailAlerts"
              checked={!!config.enableEmailAlerts}
              onChange={e => setConfig({ ...config, enableEmailAlerts: e.target.checked })}
              style={{ width: '18px', height: '18px', margin: 0 }}
            />
            <label htmlFor="enableEmailAlerts" style={{ margin: 0 }}>
              📧 Enable Email Alerts (Sends to {config.senderEmail || 'your SMTP Sender Email'})
            </label>
          </div>
        </div>

        <h3 style={{ marginTop: '2rem', marginBottom: '1rem', color: '#a5b4fc', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.25rem' }}>
          Browser Session Settings
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
          Choose whether Playwright should use your active, daily Google Chrome browser profile (so you are already logged in to all job portals) or use a fresh/isolated context.
        </p>

        <div className="form-row">
          <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
            <input
              type="checkbox"
              id="useLocalChromeProfile"
              checked={!!config.useLocalChromeProfile}
              onChange={e => setConfig({ ...config, useLocalChromeProfile: e.target.checked })}
              style={{ width: '18px', height: '18px', margin: 0 }}
            />
            <label htmlFor="useLocalChromeProfile" style={{ margin: 0 }}>
              Use my active Google Chrome profile (⚠️ Not Recommended - frequently blocked by Chrome security and file lock restrictions)
            </label>
          </div>
        </div>

        {config.useLocalChromeProfile ? (
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="chromeProfileName">Chrome Profile Directory Name</label>
              <input
                type="text"
                id="chromeProfileName"
                value={config.chromeProfileName || 'Default'}
                onChange={e => setConfig({ ...config, chromeProfileName: e.target.value })}
                placeholder="Default, Profile 1, Profile 2"
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', display: 'block' }}>
                Usually <code>Default</code> or <code>Profile 1</code>. You can see your profiles in <code>%LOCALAPPDATA%\Google\Chrome\User Data\</code>.
              </span>
            </div>
          </div>
        ) : (
          <div style={{
            background: 'rgba(99, 102, 241, 0.05)',
            border: '1px dashed rgba(99, 102, 241, 0.25)',
            borderRadius: '8px',
            padding: '1.25rem',
            marginBottom: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem'
          }}>
            <h4 style={{ color: '#a5b4fc', fontSize: '0.9rem', margin: 0 }}>
              💡 Dedicated Automation Browser Setup
            </h4>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0, lineHeight: '1.4' }}>
              We strongly recommend using the dedicated browser. To avoid logging in manually during every job application, click the button below to launch the dedicated browser, sign in to LinkedIn (and any other job boards), and close the browser. Your login session will be permanently saved!
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.25rem' }}>
              <button
                type="button"
                className="btn"
                onClick={launchAutomationBrowser}
                disabled={browserLaunching}
                style={{
                  fontSize: '0.85rem',
                  padding: '0.5rem 1rem',
                  border: '1px solid rgba(99, 102, 241, 0.4)',
                  background: 'rgba(99, 102, 241, 0.1)',
                  color: '#a5b4fc'
                }}
              >
                {browserLaunching ? 'Launching Browser...' : '🚀 Open Automation Browser for Portal Login'}
              </button>
              {browserStatus && (
                <span style={{ fontSize: '0.85rem', color: browserStatus.includes('Error') ? 'var(--color-error)' : 'var(--color-success)', fontWeight: '500' }}>
                  {browserStatus}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="form-group">
          <label htmlFor="resume">Master Resume (Markdown or Plain Text)</label>
          <textarea
            id="resume"
            rows="12"
            value={config.masterResume}
            onChange={e => setConfig({ ...config, masterResume: e.target.value })}
            placeholder="John Doe&#10;Email: john.doe@example.com&#10;...&#10;Experience:&#10;- Software Engineer at Acme Corp (2022-Present)&#10;  - Built full stack React applications..."
            required
          ></textarea>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem' }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving Profile...' : 'Save Profile & Update Config'}
          </button>
        </div>
      </form>
    </div>
  );
}
