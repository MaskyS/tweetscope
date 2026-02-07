import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';
import { jobPolling } from './Job/Run';
import JobProgress from './Job/Progress';
import { Button, Input } from 'react-element-forge';
import { apiUrl, apiService } from '../lib/apiService';
import { extractTwitterArchiveForImport } from '../lib/twitterArchiveParser';
const readonly = import.meta.env.MODE == 'read_only';

import './Home.css';

function Home({ appConfig = null }) {
  const features = appConfig?.features || {};
  const limits = appConfig?.limits || {};
  const canTwitterImport = features.twitter_import ?? !readonly;
  const maxUploadMb = limits.max_upload_mb;

  const [datasets, setDatasets] = useState([]);

  useEffect(() => {
    apiService.fetchDatasets().then(setDatasets);
  }, []);

  const [scopes, setScopes] = useState({});

  useEffect(() => {
    datasets.forEach((dataset) => {
      apiService.fetchScopes(dataset.id).then((data) =>
        setScopes((prevScopes) => {
          const ret = { ...prevScopes };
          ret[dataset.id] = data;
          return ret;
        })
      );
    });
  }, [datasets]);
  useEffect(() => {
    console.log('scopes', scopes);
  }, [scopes]);

  const parseApiResponse = useCallback(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Request failed (${response.status})`);
    }
    return data;
  }, []);

  function sanitizeName(fileName) {
    let datasetName = fileName.substring(0, fileName.lastIndexOf('.'));
    datasetName = datasetName.replace(/\s/g, '-');
    return datasetName;
  }

  const navigate = useNavigate();

  const [twitterImportJob, setTwitterImportJob] = useState(null);
  const [twitterArchiveFile, setTwitterArchiveFile] = useState(null);
  const [twitterArchiveDatasetName, setTwitterArchiveDatasetName] = useState('');
  const [twitterArchiveYear, setTwitterArchiveYear] = useState('');
  const [processArchiveLocally, setProcessArchiveLocally] = useState(true);
  const [twitterArchiveExtracting, setTwitterArchiveExtracting] = useState(false);
  const [localExtractedRecordCount, setLocalExtractedRecordCount] = useState(null);

  const [communityUsername, setCommunityUsername] = useState('');
  const [communityDatasetName, setCommunityDatasetName] = useState('');
  const [communityYear, setCommunityYear] = useState('');
  const [twitterImportError, setTwitterImportError] = useState('');

  const handleTwitterArchiveSelected = useCallback((event) => {
    const file = event.target.files?.[0];
    setTwitterArchiveFile(file || null);
    setLocalExtractedRecordCount(null);
    if (file?.name) {
      setTwitterArchiveDatasetName(sanitizeName(file.name));
    }
  }, []);

  const submitTwitterArchiveImport = useCallback(
    async (event) => {
      event.preventDefault();
      if (!twitterArchiveFile || !twitterArchiveDatasetName) return;
      setTwitterImportError('');
      setTwitterImportJob(null);
      setLocalExtractedRecordCount(null);
      const formData = new FormData();
      formData.append('dataset', twitterArchiveDatasetName);
      formData.append('run_pipeline', 'true');
      if (twitterArchiveYear) {
        formData.append('year', twitterArchiveYear);
      }
      try {
        if (processArchiveLocally) {
          setTwitterArchiveExtracting(true);
          const extracted = await extractTwitterArchiveForImport(twitterArchiveFile);
          const recordCount =
            extracted?.total_count ||
            (extracted?.tweet_count || extracted?.tweets?.length || 0) +
              (extracted?.likes_count || extracted?.likes?.length || 0);
          setLocalExtractedRecordCount(recordCount || null);
          const payload = JSON.stringify(extracted);
          const extractedFile = new File([payload], `twitter-extract-${Date.now()}.json`, {
            type: 'application/json',
          });
          formData.append('source_type', 'community_json');
          formData.append('file', extractedFile);
        } else {
          formData.append('source_type', 'zip');
          formData.append('file', twitterArchiveFile);
        }

        const data = await fetch(`${apiUrl}/jobs/import_twitter`, {
          method: 'POST',
          body: formData,
        }).then(parseApiResponse);
        jobPolling({ id: data.dataset || twitterArchiveDatasetName }, setTwitterImportJob, data.job_id);
      } catch (error) {
        console.error('Error:', error);
        setTwitterImportError(error.message || 'Failed to start import');
      } finally {
        setTwitterArchiveExtracting(false);
      }
    },
    [
      twitterArchiveFile,
      twitterArchiveDatasetName,
      twitterArchiveYear,
      parseApiResponse,
      processArchiveLocally,
    ]
  );

  const submitCommunityImport = useCallback(
    (event) => {
      event.preventDefault();
      if (!communityUsername || !communityDatasetName) return;
      setTwitterImportError('');
      setTwitterImportJob(null);

      const formData = new FormData();
      formData.append('dataset', communityDatasetName);
      formData.append('source_type', 'community');
      formData.append('run_pipeline', 'true');
      formData.append('username', communityUsername);
      if (communityYear) {
        formData.append('year', communityYear);
      }

      fetch(`${apiUrl}/jobs/import_twitter`, {
        method: 'POST',
        body: formData,
      })
        .then(parseApiResponse)
        .then((data) => {
          jobPolling({ id: data.dataset || communityDatasetName }, setTwitterImportJob, data.job_id);
        })
        .catch((error) => {
          console.error('Error:', error);
          setTwitterImportError(error.message || 'Failed to start import');
        });
    },
    [communityUsername, communityDatasetName, communityYear, parseApiResponse]
  );

  useEffect(() => {
    if (!twitterImportJob || twitterImportJob.status !== 'completed') return;

    const datasetId = twitterImportJob.dataset;
    const scopeId = twitterImportJob.scope_id;
    if (datasetId && scopeId) {
      navigate(`/datasets/${datasetId}/explore/${scopeId}`);
      return;
    }

    if (datasetId) {
      apiService.fetchScopes(datasetId).then((scopeRows) => {
        const sorted = [...scopeRows].sort((a, b) => a.id.localeCompare(b.id));
        const latest = sorted[sorted.length - 1];
        if (latest?.id) {
          navigate(`/datasets/${datasetId}/explore/${latest.id}`);
        } else {
          navigate('/import');
        }
      });
    }
  }, [twitterImportJob, navigate]);

  const twitterArchiveNameTaken = datasets.some((dataset) => dataset.id === twitterArchiveDatasetName);
  const communityNameTaken = datasets.some((dataset) => dataset.id === communityDatasetName);

  return (
    <div className="home">
      {readonly || !canTwitterImport ? null : (
        <div className="new section">
          <div className="new-dataset">
            <form onSubmit={submitTwitterArchiveImport}>
              <h3>Import native X archive</h3>
              <label htmlFor="twitter-archive-upload">
                <span>Upload your X export zip and auto-build your knowledge index</span>
              </label>
              {maxUploadMb ? <span>Upload limit: {maxUploadMb} MB</span> : null}
              <label htmlFor="twitter-local-parse">
                <input
                  id="twitter-local-parse"
                  type="checkbox"
                  checked={processArchiveLocally}
                  onChange={(e) => setProcessArchiveLocally(e.target.checked)}
                />
                <span>Process archive locally in browser before upload (privacy mode)</span>
              </label>
              {processArchiveLocally ? <span>Uploads extracted tweet JSON instead of raw zip.</span> : null}
              <input
                id="twitter-archive-upload"
                type="file"
                accept=".zip"
                onChange={handleTwitterArchiveSelected}
              />
              <Input
                id="twitter-archive-dataset-name"
                type="text"
                placeholder="Dataset name"
                value={twitterArchiveDatasetName}
                onChange={(e) => setTwitterArchiveDatasetName(e.target.value)}
              />
              <Input
                id="twitter-archive-year"
                type="number"
                placeholder="Optional year filter (e.g. 2025)"
                value={twitterArchiveYear}
                onChange={(e) => setTwitterArchiveYear(e.target.value)}
              />
              {twitterArchiveNameTaken ? (
                <div className="name-taken-warning">This dataset name is already taken.</div>
              ) : null}
              <Button
                type="submit"
                disabled={
                  !twitterArchiveFile ||
                  !twitterArchiveDatasetName ||
                  twitterArchiveNameTaken ||
                  twitterArchiveExtracting
                }
                text={twitterArchiveExtracting ? 'Processing archive locally...' : 'Import Archive'}
              />
            </form>
            {localExtractedRecordCount ? (
              <span>Prepared {localExtractedRecordCount} tweet/like records locally for upload.</span>
            ) : null}
          </div>
          <div className="hf-downloader">
            <form onSubmit={submitCommunityImport}>
              <h3>Import from Community Archive</h3>
              <label htmlFor="community-username">
                <span>Fetch a public archive by username and auto-build your knowledge index</span>
              </label>
              <Input
                id="community-username"
                type="text"
                placeholder="Username (without @)"
                value={communityUsername}
                onChange={(e) => setCommunityUsername(e.target.value)}
              />
              <Input
                id="community-dataset-name"
                type="text"
                placeholder="Dataset name"
                value={communityDatasetName}
                onChange={(e) => setCommunityDatasetName(e.target.value)}
              />
              <Input
                id="community-year"
                type="number"
                placeholder="Optional year filter (e.g. 2025)"
                value={communityYear}
                onChange={(e) => setCommunityYear(e.target.value)}
              />
              {communityNameTaken ? (
                <div className="name-taken-warning">This dataset name is already taken.</div>
              ) : null}
              <Button
                type="submit"
                disabled={!communityUsername || !communityDatasetName || communityNameTaken}
                text="Import Community Archive"
              />
            </form>
          </div>
          {twitterImportError ? <div className="name-taken-warning">{twitterImportError}</div> : null}
          <JobProgress job={twitterImportJob} clearJob={() => setTwitterImportJob(null)} />
        </div>
      )}

      <div className="section datasets">
        <h3>Datasets</h3>
        <div className="datasets-content">
          {datasets.map((dataset) => (
            <div className="dataset" key={dataset.id}>
              <h3>
                {' '}
                {dataset.id}
              </h3>
              <span>{dataset.length} rows</span>
              <div className="scope-links">
                {scopes[dataset.id] &&
                  scopes[dataset.id].map &&
                  scopes[dataset.id]?.map((scope, i) => (
                    <div className="scope-link" key={i}>
                      <Link to={`/datasets/${dataset.id}/explore/${scope.id}`}>
                        {scope.label || scope.id}
                        <br />
                        {scope.ignore_hulls ? (
                          <img src={`${apiUrl}/files/${dataset.id}/umaps/${scope.umap_id}.png`} />
                        ) : (
                          <img
                            src={`${apiUrl}/files/${dataset.id}/clusters/${scope.cluster_id}.png`}
                          />
                        )}
                      </Link>
                      <br />
                      <span className="scope-description">{scope.description}</span>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Home.propTypes = {
  appConfig: PropTypes.object,
};

export default Home;
