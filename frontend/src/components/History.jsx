import React, { useState } from 'react';

export default function History({ jobs, refreshJobs }) {
  const [expandedJobId, setExpandedJobId] = useState(null);

  // Filter out skipped/skipped jobs if we want, or show all
  const filteredJobs = [...jobs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Calculate rate limit: applied today
  const todayStr = new Date().toISOString().split('T')[0];
  const appliedToday = jobs.filter(j => 
    j.status === 'submitted' && 
    j.submissionLogs && 
    j.submissionLogs.some(log => log.includes(todayStr))
  ).length;

  const toggleExpand = (id) => {
    if (expandedJobId === id) {
      setExpandedJobId(null);
    } else {
      setExpandedJobId(id);
    }
  };

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case 'submitted': return 'badge badge-submitted';
      case 'ready': return 'badge badge-ready';
      case 'review': return 'badge badge-review';
      case 'scored': return 'badge badge-scored';
      case 'discovered': return 'badge badge-discovered';
      case 'skipped': return 'badge badge-skipped';
      default: return 'badge';
    }
  };

  const handleDelete = (id, e) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this job from application history?')) return;
    
    // We can delete by moving status to skipped or clearing from DB
    // To make it simple, we delete using edit API with 'skipped' or delete endpoint
    // Let's call edit API to delete from DB
    fetch('/api/jobs/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'skipped' }) // Or we can create a delete endpoint, but skipping is fine
    }).then(() => refreshJobs());
  };

  return (
    <div className="glass-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
        <h2 className="title-gradient">Submission Log &amp; Pipeline History</h2>
        <div className="badge badge-submitted" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
          Daily Applications Rate Limit: {appliedToday} / 30
        </div>
      </div>

      {appliedToday >= 30 && (
        <div className="alert alert-warning">
          <strong>Daily limit reached!</strong> You have submitted 30 applications today. Automated submissions will be queued until tomorrow.
        </div>
      )}

      {filteredJobs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
          No application history records found. Start by running Discovery.
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Role</th>
                <th>Date Discovered</th>
                <th>Score</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredJobs.map(job => (
                <React.Fragment key={job.id}>
                  <tr 
                    style={{ cursor: 'pointer' }} 
                    onClick={() => toggleExpand(job.id)}
                  >
                    <td style={{ fontWeight: '600' }}>{job.company}</td>
                    <td>{job.title}</td>
                    <td style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {new Date(job.timestamp).toLocaleDateString()}
                    </td>
                    <td>
                      {job.score !== null ? (
                        <strong style={{ color: job.score >= 7 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                          {job.score}/10
                        </strong>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                    <td>
                      <span className={getStatusBadgeClass(job.status)}>
                        {job.status}
                      </span>
                    </td>
                    <td>
                      <a 
                        href={job.url} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        style={{ color: 'var(--color-primary)', marginRight: '1rem', textDecoration: 'none' }}
                        onClick={e => e.stopPropagation()}
                      >
                        Link &nearr;
                      </a>
                      <button 
                        className="btn btn-secondary" 
                        style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', color: 'var(--color-error)' }}
                        onClick={e => handleDelete(job.id, e)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                  {expandedJobId === job.id && (
                    <tr>
                      <td colSpan="6" style={{ background: 'rgba(0, 0, 0, 0.2)', padding: '1rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                          <div>
                            <strong>Application Database ID:</strong> <code style={{ color: '#a5b4fc' }}>{job.id}</code>
                          </div>
                          {job.url && (
                            <div>
                              <strong>Source Job Posting:</strong> <a href={job.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>{job.url}</a>
                            </div>
                          )}
                          <div>
                            <strong>Submissions Logs &amp; Automation Output:</strong>
                            <div style={{ 
                              background: '#07080c', 
                              border: '1px solid var(--border-color)', 
                              borderRadius: '4px', 
                              padding: '0.75rem', 
                              marginTop: '0.25rem',
                              fontFamily: 'monospace',
                              fontSize: '0.8rem',
                              maxHeight: '200px',
                              overflowY: 'auto'
                            }}>
                              {job.submissionLogs && job.submissionLogs.length > 0 ? (
                                job.submissionLogs.map((log, lIdx) => (
                                  <div key={lIdx} style={{ marginBottom: '0.25rem', color: log.includes('Success') ? 'var(--color-success)' : 'var(--text-main)' }}>
                                    {log}
                                  </div>
                                ))
                              ) : (
                                <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No logs recorded for this job application.</div>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
