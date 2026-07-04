import React, { useState, useEffect } from 'react';

export default function QueueManager({ jobs, refreshJobs }) {
  const [activeTab, setActiveTab] = useState('scored'); // 'scored', 'review', 'ready', 'exported'
  const [selectedJob, setSelectedJob] = useState(null);
  const [analyzingId, setAnalyzingId] = useState(null);
  const [applyingId, setApplyingId] = useState(null);
  const [connectingId, setConnectingId] = useState(null);
  const [markingAppliedId, setMarkingAppliedId] = useState(null);

  // Form edit states
  const [editResume, setEditResume] = useState('');
  const [editCoverLetter, setEditCoverLetter] = useState('');
  const [editColdEmail, setEditColdEmail] = useState('');
  const [savingEdits, setSavingEdits] = useState(false);
  const [subTab, setSubTab] = useState('resume'); // 'resume', 'coverletter', 'coldemail'
  
  // Cold email automation states
  const [recipientEmail, setRecipientEmail] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailStatus, setEmailStatus] = useState({ text: '', type: '' });

  // Purge skipped state
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState('');

  // Alerts sync states
  const [syncingAlerts, setSyncingAlerts] = useState(false);
  const [alertsStatus, setAlertsStatus] = useState('');
  const [sendingToAlertsId, setSendingToAlertsId] = useState(null);

  // Filter jobs based on active tab
  const filteredJobs = jobs.filter(j => {
    if (activeTab === 'scored') return j.status === 'scored';
    if (activeTab === 'review') return j.status === 'review';
    if (activeTab === 'ready') return j.status === 'ready';
    if (activeTab === 'exported') return j.status === 'exported';
    return false;
  });

  // Select first job when tab changes or update reference on background update
  useEffect(() => {
    if (filteredJobs.length > 0) {
      const stillExists = selectedJob ? filteredJobs.find(j => j.id === selectedJob.id) : null;
      if (stillExists) {
        setSelectedJob(stillExists);
        if (!editResume && stillExists.tailoredResume) setEditResume(stillExists.tailoredResume);
        if (!editCoverLetter && stillExists.coverLetter) setEditCoverLetter(stillExists.coverLetter);
        if (!editColdEmail && stillExists.coldEmail) setEditColdEmail(stillExists.coldEmail);
      } else {
        handleSelectJob(filteredJobs[0]);
      }
    } else {
      setSelectedJob(null);
    }
  }, [activeTab, jobs]);

  const handleSelectJob = (job) => {
    setSelectedJob(job);
    setEditResume(job.tailoredResume || '');
    setEditCoverLetter(job.coverLetter || '');
    
    // Parse subject from email body
    let parsedSubject = `Job Inquiry: ${job.title} at ${job.company}`;
    let parsedBody = job.coldEmail || '';
    if (job.coldEmail) {
      const lines = job.coldEmail.split('\n');
      const subLine = lines.find(l => l.toLowerCase().startsWith('subject:'));
      if (subLine) {
        parsedSubject = subLine.substring(8).trim();
        parsedBody = lines.filter(l => !l.toLowerCase().startsWith('subject:')).join('\n').trim();
      }
    }
    
    setEditColdEmail(parsedBody);
    setSubTab('resume'); // reset sub-tab
    setRecipientEmail(job.hrEmail || job.poster?.email || '');
    setEmailSubject(parsedSubject);
    setEmailStatus({ text: '', type: '' });
  };

  const triggerAnalysis = (jobId) => {
    setAnalyzingId(jobId);
    fetch('/api/jobs/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId })
    })
      .then(res => res.json())
      .then(() => {
        setAnalyzingId(null);
        refreshJobs();
      })
      .catch(err => {
        console.error(err);
        setAnalyzingId(null);
      });
  };

  const triggerApply = (jobId) => {
    setApplyingId(jobId);
    fetch('/api/jobs/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId })
    })
      .then(res => res.json())
      .then(() => {
        setApplyingId(null);
        refreshJobs();
      })
      .catch(err => {
        console.error(err);
        setApplyingId(null);
      });
  };

  const triggerMarkApplied = (jobId) => {
    setMarkingAppliedId(jobId);
    fetch('/api/jobs/mark-applied', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId })
    })
      .then(res => res.json())
      .then(() => {
        setMarkingAppliedId(null);
        refreshJobs();
      })
      .catch(err => {
        console.error(err);
        setMarkingAppliedId(null);
      });
  };

  const triggerLinkedInConnect = (jobId) => {
    setConnectingId(jobId);
    fetch('/api/jobs/linkedin-connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId })
    })
      .then(res => res.json())
      .then(data => {
        setConnectingId(null);
        if (data.success) {
          alert(data.message);
          refreshJobs();
        } else {
          alert(data.error || data.message || 'Failed to connect.');
        }
      })
      .catch(err => {
        setConnectingId(null);
        alert(`Error: ${err.message}`);
      });
  };

  const handleSaveEdits = () => {
    if (!selectedJob) return;
    setSavingEdits(true);

    fetch('/api/jobs/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: selectedJob.id,
        tailoredResume: editResume,
        coverLetter: editCoverLetter,
        coldEmail: editColdEmail
      })
    })
      .then(res => res.json())
      .then(data => {
        setSavingEdits(false);
        if (data.success) {
          refreshJobs();
          alert('Edits saved successfully!');
        }
      })
      .catch(err => {
        setSavingEdits(false);
        console.error(err);
      });
  };

  const triggerSendEmail = () => {
    if (!recipientEmail) {
      alert('Please enter a recipient email address.');
      return;
    }
    setSendingEmail(true);
    setEmailStatus({ text: 'Sending outreach email...', type: 'info' });

    fetch('/api/jobs/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: selectedJob.id,
        toEmail: recipientEmail,
        subject: emailSubject,
        emailBody: editColdEmail
      })
    })
      .then(res => res.json())
      .then(data => {
        setSendingEmail(false);
        if (data.success) {
          setEmailStatus({ text: 'Cold email sent successfully and logged!', type: 'success' });
          refreshJobs();
        } else {
          setEmailStatus({ text: `Failed: ${data.error}`, type: 'error' });
        }
      })
      .catch(err => {
        setSendingEmail(false);
        setEmailStatus({ text: `Error: ${err.message}`, type: 'error' });
      });
  };

  const updateStatus = (jobId, newStatus) => {
    fetch('/api/jobs/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId, status: newStatus })
    })
      .then(res => res.json())
      .then(() => {
        refreshJobs();
      })
      .catch(err => console.error(err));
  };

  const syncToAlerts = () => {
    setSyncingAlerts(true);
    setAlertsStatus('Syncing finished jobs...');
    fetch('/api/jobs/sync-alerts', { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        setSyncingAlerts(false);
        if (data.success) {
          setAlertsStatus(data.message);
          refreshJobs();
          setTimeout(() => setAlertsStatus(''), 4000);
        } else {
          setAlertsStatus(`Error: ${data.error || 'Failed'}`);
        }
      })
      .catch(err => {
        setSyncingAlerts(false);
        setAlertsStatus(`Error: ${err.message}`);
      });
  };

  // Bulk approve all review jobs
  const approveAll = () => {
    const reviewJobs = jobs.filter(j => j.status === 'review');
    if (reviewJobs.length === 0) return;
    const promises = reviewJobs.map(job =>
      fetch('/api/jobs/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, status: 'ready' })
      })
    );
    Promise.all(promises)
      .then(() => refreshJobs())
      .catch(err => console.error('Approve All error:', err));
  };

  const sendSingleToAlerts = (jobId, force = false) => {
    setSendingToAlertsId(jobId);
    fetch('/api/jobs/send-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: jobId, force })
    })
      .then(res => res.json())
      .then(data => {
        setSendingToAlertsId(null);
        if (data.success) {
          alert('Job details successfully sent to Alerts!');
          refreshJobs();
        } else {
          if (data.message && data.message.includes('skipped')) {
            if (window.confirm('Job was skipped due to Gulf location filter. Do you want to force send it anyway?')) {
              sendSingleToAlerts(jobId, true);
            }
          } else {
            alert(data.error || data.message || 'Failed to send to Alerts');
          }
        }
      })
      .catch(err => {
        setSendingToAlertsId(null);
        alert(`Error: ${err.message}`);
      });
  };

  const purgeSkipped = () => {
    const skippedCount = jobs.filter(j => j.status === 'skipped').length;
    if (skippedCount === 0) { setPurgeMsg('No skipped jobs to remove.'); return; }
    if (!window.confirm(`Remove all ${skippedCount} skipped jobs from the database and Google Sheet? This cannot be undone.`)) return;
    setPurging(true);
    setPurgeMsg('');
    fetch('/api/jobs/purge-skipped', { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        setPurging(false);
        setPurgeMsg(data.message || 'Done.');
        refreshJobs();
      })
      .catch(err => {
        setPurging(false);
        setPurgeMsg('Error: ' + err.message);
      });
  };

  // Simple diff renderer (highlights changes in bullet points)
  const renderResumeDiff = () => {
    if (!selectedJob || !selectedJob.tailoredResume) return null;
    return (
      <div className="resume-diff-box">
        {selectedJob.tailoredResume.split('\n').map((line, idx) => {
          const isAdded = line.startsWith('+') || line.trim().startsWith('- [x]') || (selectedJob.analysis && selectedJob.analysis.keywords.some(kw => line.toLowerCase().includes(kw.toLowerCase())));
          return (
            <div key={idx} className={isAdded ? "resume-diff-add" : ""}>
              {line}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* Tab Navs + Purge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div className="nav-tabs" style={{ alignSelf: 'flex-start' }}>
          <button 
            className={`tab-btn ${activeTab === 'scored' ? 'active' : ''}`}
            onClick={() => setActiveTab('scored')}
          >
            Scored Matches ({jobs.filter(j => j.status === 'scored').length})
          </button>
          <button 
            className={`tab-btn ${activeTab === 'review' ? 'active' : ''}`}
            onClick={() => setActiveTab('review')}
          >
            Human Review Queue ({jobs.filter(j => j.status === 'review').length})
          </button>
          <button 
            className={`tab-btn ${activeTab === 'ready' ? 'active' : ''}`}
            onClick={() => setActiveTab('ready')}
          >
            Ready to Apply ({jobs.filter(j => j.status === 'ready').length})
          </button>
          <button 
            className={`tab-btn ${activeTab === 'exported' ? 'active' : ''}`}
            onClick={() => setActiveTab('exported')}
          >
            Exported Assets ({jobs.filter(j => j.status === 'exported').length})
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {(purgeMsg || alertsStatus) && (
            <span style={{ fontSize: '0.8rem', color: (purgeMsg?.startsWith('Error') || alertsStatus?.startsWith('Error')) ? 'var(--color-error)' : 'var(--color-success)' }}>
              {purgeMsg || alertsStatus}
            </span>
          )}
          <button
            id="sync-alerts-btn"
            className="btn btn-primary"
            onClick={syncToAlerts}
            disabled={syncingAlerts || jobs.filter(j => (j.status === 'ready' || j.status === 'review') && !j.alertSent).length === 0}
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', opacity: jobs.filter(j => (j.status === 'ready' || j.status === 'review') && !j.alertSent).length === 0 ? 0.4 : 1 }}
          >
            {syncingAlerts ? 'Syncing...' : `📤 Sync to Alerts (${jobs.filter(j => (j.status === 'ready' || j.status === 'review') && !j.alertSent).length})`}
          </button>
          {/* Approve All Button for Review Queue */}
          {activeTab === 'review' && (
            <button
              id="approve-all-btn"
              className="btn btn-success"
              onClick={approveAll}
              disabled={jobs.filter(j => j.status === 'review').length === 0}
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', marginLeft: '0.5rem' }}
            >
              ✅ Approve All ({jobs.filter(j => j.status === 'review').length})
            </button>
          )}

          <button
            id="purge-skipped-btn"
            className="btn btn-danger"
            onClick={purgeSkipped}
            disabled={purging || jobs.filter(j => j.status === 'skipped').length === 0}
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem', opacity: jobs.filter(j => j.status === 'skipped').length === 0 ? 0.4 : 1 }}
          >
            {purging ? 'Purging...' : `🗑️ Purge Skipped (${jobs.filter(j => j.status === 'skipped').length})`}
          </button>
        </div>
      </div>

      <div className="pipeline-layout">
        
        {/* Left Side: Job Cards */}
        <div className="pipeline-list">
          {filteredJobs.length === 0 ? (
            <div className="glass-card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
              No jobs in this queue.
            </div>
          ) : (
            filteredJobs.map(job => (
              <div 
                key={job.id} 
                className={`glass-card job-card ${selectedJob && selectedJob.id === job.id ? 'active' : ''}`}
                onClick={() => handleSelectJob(job)}
              >
                <div className="job-header-row">
                  <div>
                    <h4 style={{ color: '#fff' }}>{job.title}</h4>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{job.company}</span>
                  </div>
                  {job.score !== null && (
                    <span className="job-score-badge">{job.score}/10</span>
                  )}
                  {/* Alerts Sent Indicator */}
                  {job.alertSent === true && (
                    <span style={{ marginLeft: '0.5rem', color: 'var(--color-success)' }}>✅ Sent</span>
                  )}
                  {job.alertSent === 'skipped' && (
                    <span style={{ marginLeft: '0.5rem', color: 'var(--color-warning)' }}>🔕 Alerts Skipped</span>
                  )}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {job.url}
                </p>
                
                {job.status === 'review' && job.confidence && (
                  <div style={{ marginTop: '0.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.75rem', color: '#fbbf24' }}>Confidence: {job.confidence}%</span>
                    <span className="badge badge-review">Needs Review</span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Right Side: Detailed Panel */}
        <div className="job-details-panel">
          {selectedJob ? (
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              
              {/* Card Header */}
              <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h2 className="title-gradient">{selectedJob.title}</h2>
                  <h4 style={{ color: 'var(--text-muted)' }}>{selectedJob.company}</h4>
                  <a href={selectedJob.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.85rem', color: 'var(--color-primary)' }}>
                    View Listing Page &nearr;
                  </a>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {(selectedJob.status === 'ready' || selectedJob.status === 'review') && (
                    <button 
                      className="btn btn-secondary" 
                      onClick={() => sendSingleToAlerts(selectedJob.id, false)}
                      disabled={sendingToAlertsId === selectedJob.id}
                      style={{ background: 'var(--color-primary-dark)', borderColor: 'var(--color-primary)' }}
                    >
                      {sendingToAlertsId === selectedJob.id ? 'Sending...' : '📤 Send to Alerts'}
                    </button>
                  )}
                  <button className="btn btn-danger" onClick={() => updateStatus(selectedJob.id, 'skipped')}>
                    Skip/Reject
                  </button>
                  {selectedJob.status === 'review' && (
                    <button className="btn btn-success" onClick={() => updateStatus(selectedJob.id, 'ready')}>
                      Approve
                    </button>
                  )}
                </div>
              </div>

              {/* Match Score Reason */}
              {selectedJob.scoreReason && (
                <div className="alert alert-success" style={{ margin: 0 }}>
                  <strong>Match Score Explanation ({selectedJob.score}/10):</strong> {selectedJob.scoreReason}
                </div>
              )}

              {/* Generated Asset Directory Details */}
              {selectedJob.status === 'exported' && selectedJob.folderPath && (
                <div className="alert alert-success" style={{ margin: 0, border: '1px solid var(--color-success)', background: 'rgba(16, 185, 129, 0.05)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 'bold' }}>
                    <span>📁</span> Assets Exported to Local Folder:
                  </div>
                  <code style={{ background: 'rgba(0,0,0,0.3)', padding: '0.5rem', borderRadius: '4px', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.85rem', color: '#fff' }}>
                    {selectedJob.folderPath}
                  </code>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Open this path on your computer. It contains your tailored <strong>PDF resume</strong>, cover letter text, and cold email outreach note.
                  </div>
                </div>
              )}

              {/* Scored Stage Actions */}
              {selectedJob.status === 'scored' && (
                <div style={{ padding: '2rem 1rem', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
                  <p style={{ marginBottom: '1.25rem', color: 'var(--text-muted)' }}>
                    This job description has passed initial scoring. Ready to trigger abhii resume & cover letter tailoring.
                  </p>
                  <button 
                    className="btn btn-primary" 
                    onClick={() => triggerAnalysis(selectedJob.id)}
                    disabled={analyzingId === selectedJob.id}
                  >
                    {analyzingId === selectedJob.id ? 'Tailoring Resume & Cover Letter...' : 'Run Deep Analysis & Tailor Resume'}
                  </button>
                </div>
              )}

              {/* Deep Analysis Metadata Panel */}
              {selectedJob.analysis && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <h5 className="section-title">Required Skills</h5>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                      {selectedJob.analysis.requiredSkills.map((sk, idx) => (
                        <span key={idx} style={{ background: 'rgba(255,255,255,0.05)', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.8rem' }}>{sk}</span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h5 className="section-title">Seniority & Culture</h5>
                    <div style={{ fontSize: '0.85rem' }}>
                      <div><strong>Seniority:</strong> {selectedJob.analysis.seniority}</div>
                      <div><strong>Tone:</strong> {selectedJob.analysis.tone}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Recruiter / HR / Poster Info */}
              {(selectedJob.poster && (selectedJob.poster.name || selectedJob.poster.title || selectedJob.poster.url)) || selectedJob.hrEmail || selectedJob.careerSiteUrl ? (
                <div className="glass-card" style={{ border: '1px solid rgba(255,255,255,0.08)', padding: '0.75rem 1rem', display: 'flex', gap: '1rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.02)', margin: '0' }}>
                  <div style={{ fontSize: '1.5rem', opacity: 0.8 }}>👤</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.05em' }}>Recruiter / Job Poster / HR</div>
                    <div style={{ fontWeight: 'bold', fontSize: '0.95rem', color: '#fff' }}>
                      {(selectedJob.poster && selectedJob.poster.name) || 'Anonymous Recruiter'}
                    </div>
                    {selectedJob.poster && selectedJob.poster.title && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{selectedJob.poster.title}</div>
                    )}
                    {selectedJob.hrEmail && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--color-primary)' }}>HR Email: {selectedJob.hrEmail}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {selectedJob.poster && selectedJob.poster.url && (
                      <a 
                        href={selectedJob.poster.url} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                      >
                        LinkedIn Profile &rarr;
                      </a>
                    )}
                    {selectedJob.careerSiteUrl && (
                      <a 
                        href={selectedJob.careerSiteUrl} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        className="btn btn-secondary" 
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                      >
                        Career Website &rarr;
                      </a>
                    )}
                  </div>
                </div>
              ) : null}

              {/* Deal Breaker Flag */}
              {selectedJob.analysis && selectedJob.analysis.dealBreaker && (
                <div className="alert alert-warning" style={{ margin: 0 }}>
                  <strong>Potential Deal-breaker Detected:</strong> {selectedJob.analysis.dealBreaker}
                </div>
              )}

              {selectedJob.connectionError && (
                <div className="alert alert-danger" style={{ margin: 0 }}>
                  <strong>LinkedIn Connect Error:</strong> {selectedJob.connectionError}
                </div>
              )}

              {/* Tailored Resumes, Cover Letter & Cold Email Section */}
              {(selectedJob.status === 'ready' || selectedJob.status === 'review' || selectedJob.status === 'exported') && selectedJob.tailoredResume && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  
                  {/* Confidence metrics */}
                  {selectedJob.confidence !== null && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                        <span>Application Quality Confidence:</span>
                        <strong style={{ color: selectedJob.confidence >= 80 ? 'var(--color-success)' : 'var(--color-warning)' }}>
                          {selectedJob.confidence}%
                        </strong>
                      </div>
                      <div style={{ height: '6px', background: 'rgba(255,255,255,0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ 
                          height: '100%', 
                          width: `${selectedJob.confidence}%`, 
                          background: selectedJob.confidence >= 80 ? 'var(--color-success)' : 'var(--color-warning)'
                        }} />
                      </div>
                    </div>
                  )}

                  {/* Sub-tabs Selection */}
                  <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                    <button 
                      className={`tab-btn ${subTab === 'resume' ? 'active' : ''}`}
                      onClick={() => setSubTab('resume')}
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                    >
                      Tailored Resume
                    </button>
                    <button 
                      className={`tab-btn ${subTab === 'coverletter' ? 'active' : ''}`}
                      onClick={() => setSubTab('coverletter')}
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                    >
                      Cover Letter
                    </button>
                    <button 
                      className={`tab-btn ${subTab === 'coldemail' ? 'active' : ''}`}
                      onClick={() => setSubTab('coldemail')}
                      style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                    >
                      Cold Email Outreach
                    </button>
                  </div>

                  {/* Resume Editor Tab */}
                  {subTab === 'resume' && (
                    <div>
                      <h5 className="section-title">Tailored Resume Preview (ATS Keywords Highlighted)</h5>
                      {renderResumeDiff()}
                      <textarea
                        rows="10"
                        style={{ marginTop: '0.5rem', fontFamily: 'monospace', fontSize: '0.85rem', width: '100%', padding: '0.75rem', borderRadius: '6px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff' }}
                        value={editResume}
                        onChange={e => setEditResume(e.target.value)}
                        placeholder="Tailored Resume Content..."
                      />
                    </div>
                  )}

                  {/* Cover Letter Editor Tab */}
                  {subTab === 'coverletter' && (
                    <div>
                      <h5 className="section-title">Generated Cover Letter</h5>
                      <textarea
                        rows="10"
                        style={{ fontFamily: 'var(--font-body)', fontSize: '0.9rem', width: '100%', padding: '0.75rem', borderRadius: '6px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff' }}
                        value={editCoverLetter}
                        onChange={e => setEditCoverLetter(e.target.value)}
                        placeholder="Cover Letter Content..."
                      />
                    </div>
                  )}

                  {/* Cold Email Outreach Tab */}
                  {subTab === 'coldemail' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {emailStatus.text && (
                        <div className={`alert alert-${emailStatus.type === 'error' ? 'danger' : (emailStatus.type === 'success' ? 'success' : 'info')}`} style={{ margin: 0 }}>
                          {emailStatus.text}
                        </div>
                      )}
                      
                      <div className="form-row" style={{ gap: '1rem' }}>
                        <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
                          <label>Recruiter Email</label>
                          <input 
                            type="email" 
                            value={recipientEmail} 
                            onChange={e => setRecipientEmail(e.target.value)} 
                            placeholder="recruiter-email@company.com"
                            style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff' }}
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0, flex: 2 }}>
                          <label>Email Subject</label>
                          <input 
                            type="text" 
                            value={emailSubject} 
                            onChange={e => setEmailSubject(e.target.value)} 
                            placeholder="Job Inquiry: Role Name"
                            style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff' }}
                          />
                        </div>
                      </div>

                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', marginTop: '0.5rem' }}>
                          <h5 className="section-title" style={{ margin: 0 }}>Generated Cold Email Outreach</h5>
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button 
                              className="btn btn-secondary" 
                              style={{ padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}
                              onClick={() => {
                                navigator.clipboard.writeText(`Subject: ${emailSubject}\n\n${editColdEmail}`);
                                alert('Cold email with subject copied to clipboard!');
                              }}
                              disabled={!editColdEmail}
                              type="button"
                            >
                              Copy Email
                            </button>
                            <button 
                              className="btn btn-success" 
                              style={{ padding: '0.25rem 1rem', fontSize: '0.8rem', background: '#34d399', border: 'none', color: '#000', fontWeight: 'bold' }}
                              onClick={triggerSendEmail}
                              disabled={sendingEmail || !editColdEmail || !recipientEmail}
                              type="button"
                            >
                              {sendingEmail ? 'Sending...' : 'Send Cold Email'}
                            </button>
                          </div>
                        </div>
                        <textarea
                          rows="10"
                          style={{ fontFamily: 'var(--font-body)', fontSize: '0.9rem', width: '100%', padding: '0.75rem', borderRadius: '6px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border-color)', color: '#fff' }}
                          value={editColdEmail}
                          onChange={e => setEditColdEmail(e.target.value)}
                          placeholder="Cold Email Content..."
                        />
                      </div>
                    </div>
                  )}

                  {/* Actions Bar */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                    <button className="btn btn-secondary" onClick={handleSaveEdits} disabled={savingEdits}>
                      {savingEdits ? 'Saving Edits...' : 'Save Manual Changes'}
                    </button>
                    {selectedJob.poster && selectedJob.poster.url && (
                      <button 
                        className="btn btn-secondary" 
                        onClick={() => triggerLinkedInConnect(selectedJob.id)}
                        disabled={connectingId === selectedJob.id || selectedJob.connectionSent}
                        style={{ border: '1px solid var(--color-primary)' }}
                      >
                        {connectingId === selectedJob.id 
                          ? 'Connecting...' 
                          : selectedJob.connectionSent 
                            ? `Connect Sent (${selectedJob.connectionSent === 'connected' ? 'Invite' : 'DM'})` 
                            : 'Send LinkedIn Connect'}
                      </button>
                    )}
                    {/* Generate Assets button — for ready/review jobs */}
                    {(selectedJob.status === 'ready' || selectedJob.status === 'review') && (
                      <button 
                        className="btn btn-primary" 
                        onClick={() => triggerApply(selectedJob.id)}
                        disabled={applyingId === selectedJob.id}
                        style={{ flex: 1 }}
                      >
                        {applyingId === selectedJob.id ? '📦 Generating Assets...' : '📦 Generate Assets & Export'}
                      </button>
                    )}

                    {/* Mark as Applied button — for exported jobs */}
                    {selectedJob.status === 'exported' && (
                      <button 
                        className="btn btn-success" 
                        onClick={() => triggerMarkApplied(selectedJob.id)}
                        disabled={markingAppliedId === selectedJob.id}
                        style={{ flex: 1 }}
                      >
                        {markingAppliedId === selectedJob.id ? '⏳ Marking...' : '✅ I Applied — Mark as Submitted'}
                      </button>
                    )}
                  </div>

                </div>
              )}

            </div>
          ) : (
            <div className="glass-card" style={{ textAlign: 'center', padding: '5rem', color: 'var(--text-muted)' }}>
              Select a job from the queue list to view details and control actions.
            </div>
          )}
        </div>

      </div>

    </div>
  );
}
