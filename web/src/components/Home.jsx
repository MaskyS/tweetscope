import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';
import { jobPolling } from './Job/Run';
import JobProgress from './Job/Progress';
import { Button, Input } from 'react-element-forge';
import { apiUrl, apiService } from '../lib/apiService';
import { extractTwitterArchiveForImport } from '../lib/twitterArchiveParser';
const readonly = import.meta.env.MODE == 'read_only';

import styles from './Home.module.scss';

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
  const [twitterArchiveIncludeLikes, setTwitterArchiveIncludeLikes] = useState(true);
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
      formData.append('include_likes', twitterArchiveIncludeLikes ? 'true' : 'false');
      if (twitterArchiveYear) {
        formData.append('year', twitterArchiveYear);
      }
      try {
        if (processArchiveLocally) {
          setTwitterArchiveExtracting(true);
          const extractedRaw = await extractTwitterArchiveForImport(twitterArchiveFile);
          const extracted = twitterArchiveIncludeLikes
            ? extractedRaw
            : {
                ...extractedRaw,
                likes: [],
                likes_count: 0,
                total_count: extractedRaw?.tweet_count || extractedRaw?.tweets?.length || 0,
              };
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
      twitterArchiveIncludeLikes,
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
    <div className={styles.home}>
      {/* Hero Header */}
      <div className={styles.hero}>
        <h1 className={styles.heroTitle}>Knowledge Explorer</h1>
        <p className={styles.heroSubtitle}>Import your X archive and explore your data as an interactive knowledge map</p>
      </div>

      {/* Import Cards */}
      {readonly || !canTwitterImport ? null : (
        <>
          <div className={styles.importRow}>
            {/* Native Archive Import */}
            <div className={styles.glassCard}>
              <form onSubmit={submitTwitterArchiveImport} className={styles.cardForm}>
                <h3 className={styles.cardTitle}>Import native X archive</h3>
                <p className={styles.cardDescription}>
                  Upload your X export zip and auto-build your knowledge index
                </p>

                {maxUploadMb ? <span className={styles.uploadLimit}>Upload limit: {maxUploadMb} MB</span> : null}

                {/* Privacy mode checkbox */}
                <label className={styles.checkboxRow} htmlFor="twitter-local-parse">
                  <input
                    id="twitter-local-parse"
                    type="checkbox"
                    checked={processArchiveLocally}
                    onChange={(e) => setProcessArchiveLocally(e.target.checked)}
                  />
                  <div>
                    <div className={styles.checkboxLabel}>Process archive locally in browser (privacy mode)</div>
                    {processArchiveLocally ? (
                      <div className={styles.checkboxHint}>Uploads extracted tweet JSON instead of raw zip.</div>
                    ) : null}
                  </div>
                </label>
                <label className={styles.checkboxRow} htmlFor="twitter-include-likes">
                  <input
                    id="twitter-include-likes"
                    type="checkbox"
                    checked={twitterArchiveIncludeLikes}
                    onChange={(e) => setTwitterArchiveIncludeLikes(e.target.checked)}
                  />
                  <div>
                    <div className={styles.checkboxLabel}>Include likes in import</div>
                    {!twitterArchiveIncludeLikes && processArchiveLocally ? (
                      <div className={styles.checkboxHint}>
                        Likes are stripped client-side before upload in privacy mode.
                      </div>
                    ) : null}
                  </div>
                </label>

                {/* Styled file drop zone */}
                <label htmlFor="twitter-archive-upload" className={styles.dropZone}>
                  <input
                    id="twitter-archive-upload"
                    className={styles.hiddenInput}
                    type="file"
                    accept=".zip"
                    onChange={handleTwitterArchiveSelected}
                  />
                  <span className={styles.dropZoneIcon}>&#128230;</span>
                  {twitterArchiveFile ? (
                    <span className={styles.dropZoneFileName}>{twitterArchiveFile.name}</span>
                  ) : (
                    <span className={styles.dropZoneText}>Click to select your .zip archive</span>
                  )}
                </label>

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
                  <div className={styles.warningBanner}>This dataset name is already taken.</div>
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
                <div className={styles.countBadge}>
                  Prepared {localExtractedRecordCount} records locally for upload.
                </div>
              ) : null}
            </div>

            {/* Community Archive Import */}
            <div className={styles.glassCard}>
              <form onSubmit={submitCommunityImport} className={styles.cardForm}>
                <h3 className={styles.cardTitle}>Import from Community Archive</h3>
                <p className={styles.cardDescription}>
                  Fetch a public archive by username and auto-build your knowledge index
                </p>
                <div className={styles.helperNote}>
                  Note: community archives may not include likes yet.
                </div>

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
                  <div className={styles.warningBanner}>This dataset name is already taken.</div>
                ) : null}

                <Button
                  type="submit"
                  disabled={!communityUsername || !communityDatasetName || communityNameTaken}
                  text="Import Community Archive"
                />
              </form>
            </div>
          </div>

          {/* Global import error */}
          {twitterImportError ? (
            <div className={styles.globalError}>{twitterImportError}</div>
          ) : null}

          {/* Job progress */}
          {twitterImportJob ? (
            <div className={styles.jobWrapper}>
              <JobProgress job={twitterImportJob} clearJob={() => setTwitterImportJob(null)} />
            </div>
          ) : null}
        </>
      )}

      {/* Datasets Section */}
      <div className={styles.datasetsSection}>
        <h3 className={styles.sectionTitle}>Datasets</h3>
        <div className={styles.datasetsList}>
          {datasets.length === 0 ? (
            <div className={styles.emptyState}>No datasets yet. Import your first archive above.</div>
          ) : (
            datasets.map((dataset) => (
              <div className={styles.datasetCard} key={dataset.id}>
                <div className={styles.datasetHeader}>
                  <h3 className={styles.datasetName}>{dataset.id}</h3>
                  <span className={styles.datasetRowCount}>{dataset.length} rows</span>
                </div>
                <div className={styles.scopeGrid}>
                  {scopes[dataset.id] &&
                    scopes[dataset.id].map &&
                    scopes[dataset.id]?.map((scope, i) => (
                      <Link
                        className={styles.scopeCard}
                        to={`/datasets/${dataset.id}/explore/${scope.id}`}
                        key={i}
                      >
                        <span className={styles.scopeLabel}>{scope.label || scope.id}</span>
                        {scope.ignore_hulls ? (
                          <img
                            className={styles.scopeImage}
                            src={`${apiUrl}/files/${dataset.id}/umaps/${scope.umap_id}.png`}
                            alt={scope.label || scope.id}
                          />
                        ) : (
                          <img
                            className={styles.scopeImage}
                            src={`${apiUrl}/files/${dataset.id}/clusters/${scope.cluster_id}.png`}
                            alt={scope.label || scope.id}
                          />
                        )}
                        {scope.description ? (
                          <span className={styles.scopeDescription}>{scope.description}</span>
                        ) : null}
                      </Link>
                    ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

Home.propTypes = {
  appConfig: PropTypes.object,
};

export default Home;
