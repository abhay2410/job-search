import React, { useState, useEffect, useRef } from 'react';

export default function Dashboard({ jobs, refreshJobs }) {
  const [scrapeKw, setScrapeKw] = useState('');
  const [scrapeLoc, setScrapeLoc] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [scraping, setScraping] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncingSheets, setSyncingSheets] = useState(false);
  const [syncingTelegram, setSyncingTelegram] = useState(false);
  
  const [logs, setLogs] = useState([]);
  const [sseConnected, setSseConnected] = useState(false);
  const logsEndRef = useRef(null);

  // LLM provider status
  const [llmStatus, setLlmStatus] = useState(null);

  useEffect(() => {
    const fetchStatus = () => {
      fetch('/api/llm/status')
        .then(r => r.json())
        .then(setLlmStatus)
        .catch(() => setLlmStatus(null));
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 10000); // poll every 10s
    return () => clearInterval(interval);
  }, []);

  // Stats calculation
  const stats = {
    discovered: jobs.filter(j => j.status === 'discovered').length,
    scored: jobs.filter(j => j.status === 'scored').length,
    ready: jobs.filter(j => j.status === 'ready').length,
    review: jobs.filter(j => j.status === 'review').length,
    submitted: jobs.filter(j => j.status === 'submitted').length,
    skipped: jobs.filter(j => j.status === 'skipped').length,
  };

  // Connect to SSE log stream
  useEffect(() => {
    const eventSource = new EventSource('/api/logs');
    
    eventSource.onopen = () => {
      setSseConnected(true);
    };

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLogs((prev) => [...prev, data].slice(-200)); // Limit to last 200 logs
    };

    eventSource.onerror = () => {
      setSseConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, []);

  // Scroll to bottom of logs on new logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handleScrape = (e) => {
    e.preventDefault();
    if (!scrapeKw) return;
    setScraping(true);
    
    fetch('/api/jobs/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: scrapeKw, location: scrapeLoc })
    })
      .then(res => res.json())
      .then(() => {
        setScrapeKw('');
        setScrapeLoc('');
        setScraping(false);
        // Refresh job list periodically in dashboard
        setTimeout(refreshJobs, 1000);
      })
      .catch(err => {
        console.error('Failed to trigger scrape:', err);
        setScraping(false);
      });
  };

  const handleScore = () => {
    setScoring(true);
    fetch('/api/jobs/score', {
      method: 'POST'
    })
      .then(res => res.json())
      .then(() => {
        setScoring(false);
        setTimeout(refreshJobs, 1500);
      })
      .catch(err => {
        console.error('Failed to trigger scoring:', err);
        setScoring(false);
      });
  };

  const handleImport = (e) => {
    e.preventDefault();
    if (!importUrl) return;
    setImporting(true);

    // Call generic scaping first, or check backend URL router
    // We scrape single URL by creating a discovered job
    fetch('/api/jobs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        title: 'Pending Import...', 
        company: 'Source Page', 
        url: importUrl, 
        description: 'Auto scraping page content...' 
      })
    })
      .then(res => res.json())
      .then(data => {
        setImportUrl('');
        setImporting(false);
        if (data.success && data.job) {
          refreshJobs();
          // Trigger the analysis on this newly imported URL
          fetch('/api/jobs/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: data.job.id, status: 'discovered' })
          });
        }
      })
      .catch(err => {
        console.error('Import failed:', err);
        setImporting(false);
      });
  };

  const clearLogs = () => {
    fetch('/api/logs/clear', { method: 'POST' })
      .then(() => setLogs([]))
      .catch(err => console.error(err));
  };

  const handleSheetsSync = () => {
    setSyncingSheets(true);
    fetch('/api/sync/sheets', {
      method: 'POST'
    })
      .then(res => res.json())
      .then(data => {
        setSyncingSheets(false);
        if (data.success) {
          alert('Successfully synced jobs list to Google Sheets!');
        } else {
          alert(data.error || 'Failed to sync to Google Sheets. Make sure the Apps Script URL is saved under Profile Setup.');
        }
      })
      .catch(err => {
        setSyncingSheets(false);
        alert(`Error syncing: ${err.message}`);
      });
  };

  const handleTelegramSync = () => {
    setSyncingTelegram(true);
    fetch('/api/jobs/sync-telegram', {
      method: 'POST'
    })
      .then(res => res.json())
      .then(data => {
        setSyncingTelegram(false);
        if (data.success) {
          alert(data.message || 'Synced finished jobs to Telegram!');
          refreshJobs();
        } else {
          alert(data.error || 'Failed to sync to Telegram');
        }
      })
      .catch(err => {
        setSyncingTelegram(false);
        alert(`Error syncing to Telegram: ${err.message}`);
      });
  };

  const unsentCount = jobs.filter(j => (j.status === 'ready' || j.status === 'review') && !j.telegramSent).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* LLM Provider Status Bar */}
      {llmStatus && (
        <div className="glass-card" style={{ 
          padding: '0.75rem 1.25rem',
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          gap: '1.5rem',
          borderLeft: '3px solid #818cf8'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 }}>
              AI Engine
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
            {/* Gemini */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ 
                width: 8, height: 8, borderRadius: '50%',
                backgroundColor: llmStatus.gemini?.configured ? '#34d399' : '#f87171',
                boxShadow: llmStatus.gemini?.configured ? '0 0 6px #34d399' : '0 0 6px #f87171'
              }} />
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Gemini {llmStatus.gemini?.configured ? '(Ready)' : '(No Key)'}
              </span>
              {llmStatus.primary === 'gemini' && (
                <span style={{ fontSize: '0.65rem', padding: '1px 6px', borderRadius: 6, background: 'rgba(129,140,248,0.2)', color: '#a5b4fc', fontWeight: 600 }}>PRIMARY</span>
              )}
            </div>
            {/* Local LLM */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ 
                width: 8, height: 8, borderRadius: '50%',
                backgroundColor: llmStatus.local?.online ? '#34d399' : '#fbbf24',
                boxShadow: llmStatus.local?.online ? '0 0 6px #34d399' : '0 0 6px #fbbf24'
              }} />
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Local LLM {llmStatus.local?.online 
                  ? `(${llmStatus.local.model} — ${llmStatus.local.availableModels?.length || 0} model${llmStatus.local.availableModels?.length === 1 ? '' : 's'})` 
                  : '(Ollama Offline)'}
              </span>
              {llmStatus.fallback === 'local' && (
                <span style={{ fontSize: '0.65rem', padding: '1px 6px', borderRadius: 6, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontWeight: 600 }}>FALLBACK</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Funnel KPIs */}
      <div className="funnel-container">
        <div className="glass-card funnel-card">
          <div className="funnel-num" style={{ color: '#22d3ee' }}>{stats.discovered}</div>
          <div className="funnel-label">Discovered</div>
        </div>
        <div className="glass-card funnel-card">
          <div className="funnel-num" style={{ color: '#818cf8' }}>{stats.scored}</div>
          <div className="funnel-label">Scored (Match &ge; 7)</div>
        </div>
        <div className="glass-card funnel-card">
          <div className="funnel-num" style={{ color: '#34d399' }}>{stats.ready}</div>
          <div className="funnel-label">Tailored &amp; Ready</div>
        </div>
        <div className="glass-card funnel-card">
          <div className="funnel-num" style={{ color: '#fbbf24' }}>{stats.review}</div>
          <div className="funnel-label">Review Queue</div>
        </div>
        <div className="glass-card funnel-card" style={{ border: '1px solid rgba(16, 185, 129, 0.4)' }}>
          <div className="funnel-num" style={{ color: '#6ee7b7' }}>{stats.submitted}</div>
          <div className="funnel-label">Submitted</div>
        </div>
      </div>

      {/* Control Actions Panel */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        
        {/* Scrape Form */}
        <div className="glass-card">
          <h3 style={{ marginBottom: '1rem', color: '#a5b4fc' }}>Discovery Scraper</h3>
          <form onSubmit={handleScrape} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Search Keyword</label>
              <input 
                type="text" 
                value={scrapeKw} 
                onChange={e => setScrapeKw(e.target.value)} 
                placeholder="React Developer, Node Engineer"
                required
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Location (Optional)</label>
              <input 
                type="text" 
                value={scrapeLoc} 
                onChange={e => setScrapeLoc(e.target.value)} 
                placeholder="San Francisco, Remote"
              />
            </div>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
              <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={scraping}>
                {scraping ? 'Searching...' : 'Bulk Discovery Search'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleScore} disabled={scoring || stats.discovered === 0}>
                {scoring ? 'Scoring...' : `Score Discovered (${stats.discovered})`}
              </button>
            </div>
          </form>
        </div>

        {/* URL Importer */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ marginBottom: '0.5rem', color: '#a5b4fc' }}>Direct URL Importer</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Paste a Greenhouse, Lever, or LinkedIn job posting URL to fetch, analyze, and apply to that specific role.
            </p>
          </div>
          <form onSubmit={handleImport} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Job Posting URL</label>
              <input 
                type="url" 
                value={importUrl} 
                onChange={e => setImportUrl(e.target.value)} 
                placeholder="https://boards.greenhouse.io/company/jobs/12345"
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ marginTop: '0.5rem' }} disabled={importing}>
              {importing ? 'Scraping Page...' : 'Fetch & Import Job URL'}
            </button>
          </form>
        </div>
      </div>

      {/* SSE Log Streams */}
      <div className="glass-card logs-section">
        <div className="logs-header">
          <h3 style={{ color: '#a5b4fc' }}>Active Pipeline Terminal Logs</h3>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <div className="logs-indicator">
              <div className={sseConnected ? "pulse-dot" : ""} style={!sseConnected ? {backgroundColor: 'red'} : {}}></div>
              <span>{sseConnected ? 'Live Connection Active' : 'Disconnected'}</span>
            </div>
            <button className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }} onClick={handleSheetsSync} disabled={syncingSheets}>
              {syncingSheets ? 'Syncing...' : 'Sync to Google Sheets'}
            </button>
            <button className="btn btn-primary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem', background: '#3b82f6', borderColor: '#2563eb' }} onClick={handleTelegramSync} disabled={syncingTelegram || unsentCount === 0}>
              {syncingTelegram ? 'Syncing...' : `Sync to Telegram (${unsentCount})`}
            </button>
            <button className="btn btn-secondary" style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }} onClick={clearLogs}>
              Clear Terminal
            </button>
          </div>
        </div>
        <div className="logs-container">
          {logs.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Terminal idle. System waiting for commands...</div>
          ) : (
            logs.map((log, idx) => (
              <div key={idx} className={`log-line ${log.type || 'info'}`}>
                [{new Date(log.timestamp).toLocaleTimeString()}] {log.message}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>

    </div>
  );
}
