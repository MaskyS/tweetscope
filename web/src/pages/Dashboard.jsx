import { useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueries } from '@tanstack/react-query';
import PropTypes from 'prop-types';
import { apiUrl, catalogClient } from '../lib/apiService';
import { queryKeys } from '../query/keys';
import ScopeThumbnail from '../components/ScopeThumbnail';
import ProfileAvatar from '../components/ProfileAvatar';

import styles from './Dashboard.module.scss';

function Dashboard({ appConfig = null }) {
  const { data: datasets = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.datasets(),
    queryFn: ({ signal }) => catalogClient.fetchDatasets({ signal }),
  });

  const scopes = useQueries({
    queries: datasets.map((ds) => ({
      queryKey: queryKeys.scopes(ds.id),
      queryFn: ({ signal }) => catalogClient.fetchScopes(ds.id, { signal }),
      enabled: !!ds.id,
    })),
    combine: useCallback((results) => {
      const map = {};
      datasets.forEach((ds, i) => {
        if (results[i]?.data) map[ds.id] = results[i].data;
      });
      return map;
    }, [datasets]),
  });

  // Group datasets: merge {name}-likes with its parent into one card
  const collections = useMemo(() => {
    const datasetMap = new Map(datasets.map((d) => [d.id, d]));
    const likesIds = new Set();

    for (const ds of datasets) {
      if (ds.id.endsWith('-likes')) {
        const parentId = ds.id.slice(0, -6);
        if (datasetMap.has(parentId)) {
          likesIds.add(ds.id);
        }
      }
    }

    const grouped = [];
    for (const ds of datasets) {
      if (likesIds.has(ds.id)) continue;

      const likesId = `${ds.id}-likes`;
      const likesDataset = datasetMap.has(likesId) && likesIds.has(likesId)
        ? datasetMap.get(likesId)
        : null;

      const tweetsScopes = scopes[ds.id] || [];
      const likesScopes = likesDataset ? (scopes[likesId] || []) : [];

      grouped.push({
        id: ds.id,
        tweetsDataset: ds,
        likesDataset,
        tweetsScopes,
        likesScopes,
        tweetCount: ds.row_count ?? ds.length ?? 0,
        likesCount: likesDataset ? (likesDataset.row_count ?? likesDataset.length ?? 0) : 0,
      });
    }

    return grouped;
  }, [datasets, scopes]);

  const canCreate = appConfig?.features?.twitter_import ?? true;

  return (
    <div className={styles.dashboard}>
      <div className={styles.hero}>
        <img src="/apple-touch-icon.png" alt="" className={styles.heroWatermark} />
        <h1 className={styles.heroTitle}>Tweetscope</h1>
        <p className={styles.heroSubtitle}>Every tweet tells a story. See the whole picture.</p>
      </div>

      <div className={styles.collectionsSection}>
        <div className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>Your Collections</h3>
          <Link to="/new" className={styles.newCollectionButton}>
            {canCreate ? '+ New Collection' : (
              <>Import a Twitter Account <span className={styles.comingSoonBadge}>Coming Soon</span></>
            )}
          </Link>
        </div>

        {canCreate ? (
          <div className={styles.collectionsList}>
            {loading ? (
              <div className={styles.emptyState}>Loading collections...</div>
            ) : collections.length === 0 ? (
              <div className={styles.emptyState}>
                No collections yet.{' '}
                <Link to="/new" className={styles.emptyLink}>
                  Build your first knowledge map
                </Link>
              </div>
            ) : (
              collections.map((collection) => (
                <CollectionCard key={collection.id} collection={collection} />
              ))
            )}
          </div>
        ) : (
          <div className={styles.emptyState}>
            Import your Twitter archive and explore it as a visual knowledge base.{' '}
            <Link to="/new" className={styles.emptyLink}>Join the waitlist</Link> to get notified.
          </div>
        )}
      </div>

      {!canCreate && collections.length > 0 && (
        <div className={styles.collectionsSection}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Public Maps</h3>
          </div>
          <div className={styles.collectionsList}>
            {collections.map((collection) => (
              <CollectionCard key={collection.id} collection={collection} />
            ))}
          </div>
        </div>
      )}

      <footer className={styles.footer}>
        <a
          href="https://github.com/maskys/tweetscope"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.footerLink}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          maskys/tweetscope
        </a>
      </footer>
    </div>
  );
}

function ScopeGrid({ datasetId, scopeList, typeLabel }) {
  if (!scopeList || scopeList.length === 0) return null;
  return (
    <div className={styles.scopeGrid}>
      {scopeList.map((scope, i) => {
        const label = typeLabel
          ? (scopeList.length > 1 ? `${typeLabel} — ${scope.label || scope.id}` : typeLabel)
          : (scope.label || scope.id);
        return (
          <Link
            className={styles.scopeCard}
            to={`/datasets/${datasetId}/explore/${scope.id}`}
            key={i}
          >
            <span className={styles.scopeLabel}>{label}</span>
            <ScopeThumbnail
              datasetId={datasetId}
              scopeId={scope.id}
              className={styles.scopeImage}
              fallbackSrc={
                scope.ignore_hulls || !scope.cluster_id
                  ? `${apiUrl}/files/${datasetId}/umaps/${scope.umap_id}.png`
                  : `${apiUrl}/files/${datasetId}/clusters/${scope.cluster_id}.png`
              }
              alt={label}
            />
            {scope.description && !/imported from|auto-processed/i.test(scope.description) ? (
              <span className={styles.scopeDescription}>{scope.description}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

function CollectionCard({ collection }) {
  const {
    id, tweetsDataset, likesDataset,
    tweetsScopes, likesScopes,
    tweetCount, likesCount,
  } = collection;

  const profile = tweetsDataset.profile || likesDataset?.profile;
  const displayName = profile?.username || profile?.display_name || id;
  const username = profile?.username;
  const bio = profile?.bio;

  const initial = displayName.charAt(0).toUpperCase();

  const statParts = [];
  statParts.push(`${tweetCount.toLocaleString()} tweets`);
  if (likesCount > 0) {
    statParts.push(`${likesCount.toLocaleString()} likes`);
  }

  const hasLikes = likesScopes.length > 0;
  const primaryScope = tweetsScopes[0];
  const primaryHref = primaryScope
    ? `/datasets/${tweetsDataset.id}/explore/${primaryScope.id}`
    : null;

  return (
    <div className={styles.collectionCard}>
      {primaryHref && (
        <Link to={primaryHref} className={styles.cardLink} aria-label={`Explore ${displayName}`} />
      )}
      <div className={styles.collectionHeader}>
        <ProfileAvatar
          profile={profile}
          alt={displayName}
          className={styles.avatar}
          fallbackClassName={styles.avatarFallback}
          fallbackText={initial}
        />
        <div className={styles.collectionMeta}>
          <h3 className={styles.collectionName}>
            {displayName}
            {username && <span className={styles.collectionUsername}> @{username}</span>}
            <span className={styles.collectionStats}> · {statParts.join(' · ')}</span>
          </h3>
          {bio && <p className={styles.collectionBio}>{bio}</p>}
        </div>
      </div>

      <ScopeGrid
        datasetId={tweetsDataset.id}
        scopeList={tweetsScopes}
        typeLabel={hasLikes ? 'Posted Tweets' : undefined}
      />

      {hasLikes && (
        <ScopeGrid
          datasetId={likesDataset.id}
          scopeList={likesScopes}
          typeLabel="Liked Tweets"
        />
      )}
    </div>
  );
}

Dashboard.propTypes = {
  appConfig: PropTypes.object,
};

CollectionCard.propTypes = {
  collection: PropTypes.object.isRequired,
};

ScopeGrid.propTypes = {
  datasetId: PropTypes.string.isRequired,
  scopeList: PropTypes.array.isRequired,
  typeLabel: PropTypes.string,
};

export default Dashboard;
