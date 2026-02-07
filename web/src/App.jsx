import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Home from './components/Home';
import Explore from './pages/V2/FullScreenExplore';
import Nav from './components/Nav';
import { apiService } from './lib/apiService';
import './App.css';

import 'react-element-forge/dist/style.css';
import './latentscope--brand-theme.scss';

const env = import.meta.env;
console.log('ENV', env);
const readonly = import.meta.env.MODE == 'read_only';
const docsUrl = 'https://enjalot.observablehq.cloud/latent-scope/';

function App() {
  const [appConfig, setAppConfig] = useState(null);

  useEffect(() => {
    apiService
      .fetchAppConfig()
      .then(setAppConfig)
      .catch(() => {
        // Fallback keeps existing studio behavior if backend route is unavailable.
        setAppConfig({
          mode: 'hosted',
          read_only: false,
          features: {
            can_explore: true,
            can_ingest: true,
            can_compare: false,
            can_setup: false,
            can_jobs: false,
            can_export: false,
            can_settings: false,
            twitter_import: true,
            generic_file_ingest: false,
          },
          limits: {
            max_upload_mb: null,
          },
          public_dataset_id: null,
          public_scope_id: null,
        });
      });
  }, []);

  if (readonly) {
    return (
      <div>
        <a className="docs-banner" href={docsUrl}>
          {' '}
          👉 Navigate to the documentation site
        </a>
        <iframe src={docsUrl} style={{ width: '100%', height: '100vh', border: 'none' }} />
      </div>
    );
  }
  if (!appConfig) {
    return <div>Loading...</div>;
  }

  const features = appConfig.features || {};
  const isSingleProfile = appConfig.mode === 'single_profile';
  const publicPath =
    appConfig.public_dataset_id && appConfig.public_scope_id
      ? `/datasets/${appConfig.public_dataset_id}/explore/${appConfig.public_scope_id}`
      : null;

  return (
    <Router basename={env.BASE_NAME}>
      <Nav showSettings={!!features.can_settings} />
      <div className="page">
        <Routes>
          {isSingleProfile ? (
            <>
              {publicPath ? (
                <>
                  <Route path="/" element={<Navigate to={publicPath} replace />} />
                  <Route path={publicPath} element={<Explore />} />
                  <Route path="*" element={<Navigate to={publicPath} replace />} />
                </>
              ) : (
                <>
                  <Route path="/" element={<div>Missing public scope config</div>} />
                  <Route path="*" element={<div>Missing public scope config</div>} />
                </>
              )}
            </>
          ) : (
            <>
              <Route path="/" element={<Navigate to="/import" replace />} />
              <Route path="/import" element={<Home appConfig={appConfig} />} />
              <Route path="/datasets/:dataset/explore/:scope" element={<Explore />} />
              <Route path="/settings" element={<Navigate to="/import" replace />} />
              <Route path="/datasets/:dataset/setup" element={<Navigate to="/import" replace />} />
              <Route path="/datasets/:dataset/setup/:scope" element={<Navigate to="/import" replace />} />
              <Route path="/datasets/:dataset/jobs" element={<Navigate to="/import" replace />} />
              <Route path="/datasets/:dataset/jobs/:scope" element={<Navigate to="/import" replace />} />
              <Route path="/datasets/:dataset/compare/" element={<Navigate to="/import" replace />} />
              <Route path="/datasets/:dataset/export" element={<Navigate to="/import" replace />} />
              <Route path="/datasets/:dataset/export/:scope" element={<Navigate to="/import" replace />} />
              <Route path="/datasets/:dataset/plot/:scope" element={<Navigate to="/import" replace />} />
              <Route path="*" element={<Navigate to="/import" replace />} />
            </>
          )}
        </Routes>
      </div>
    </Router>
  );
}

export default App;
