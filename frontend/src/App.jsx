import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import ProfileConfig from './components/ProfileConfig';
import QueueManager from './components/QueueManager';
import History from './components/History';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  const refreshJobs = () => {
    fetch('/api/jobs')
      .then(res => res.json())
      .then(data => {
        setJobs(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to fetch jobs database:', err);
        setLoading(false);
      });
  };

  useEffect(() => {
    refreshJobs();
    // Poll the jobs database every 10 seconds for updates from background workers
    const interval = setInterval(refreshJobs, 10000);
    return () => clearInterval(interval);
  }, []);

  const renderActiveTab = () => {
    if (loading && jobs.length === 0) {
      return (
        <div style={{ textAlign: 'center', padding: '5rem', fontSize: '1.2rem', color: 'var(--text-muted)' }}>
          Loading Pipeline Database...
        </div>
      );
    }

    switch (activeTab) {
      case 'dashboard':
        return <Dashboard jobs={jobs} refreshJobs={refreshJobs} />;
      case 'profile':
        return <ProfileConfig />;
      case 'pipelines':
        return <QueueManager jobs={jobs} refreshJobs={refreshJobs} />;
      case 'history':
        return <History jobs={jobs} refreshJobs={refreshJobs} />;
      default:
        return <Dashboard jobs={jobs} refreshJobs={refreshJobs} />;
    }
  };

  return (
    <div className="app-container">
      {/* Premium Header */}
      <header className="header">
        <div className="brand">
          <div className="logo-icon" />
          <h1 className="logo-text">abhii</h1>
        </div>
        
        {/* Navigation Tabs */}
        <nav className="nav-tabs">
          <button 
            className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          <button 
            className={`tab-btn ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
          >
            Profile Setup
          </button>
          <button 
            className={`tab-btn ${activeTab === 'pipelines' ? 'active' : ''}`}
            onClick={() => setActiveTab('pipelines')}
          >
            Job Pipeline
          </button>
          <button 
            className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            History Log
          </button>
        </nav>
      </header>

      {/* Main Body */}
      <main className="main-content">
        {renderActiveTab()}
      </main>
    </div>
  );
}

export default App;
