import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronDown, House } from 'lucide-react';
import PropTypes from 'prop-types';
import ProfileAvatar from './ProfileAvatar';
import styles from './SubNav.module.css';

function deriveCollectionLabel(dataset) {
  const name = dataset?.profile?.display_name || dataset?.profile?.username || dataset?.id || '';
  const isLikes = dataset?.id?.endsWith('-likes');
  return `${name}'s ${isLikes ? 'likes' : 'tweets'}`;
}

const SubNav = ({ dataset, scope, scopes, onScopeChange, onBack, overlay = false, embedded = false }) => {
  const subHeaderClassName = embedded
    ? `${styles.subHeaderContainer} ${styles.embedded}`
    : overlay
      ? `${styles.subHeaderContainer} ${styles.overlay}`
      : styles.subHeaderContainer;

  const contextBarClassName = embedded
    ? `${styles.contextBar} ${styles.embeddedContextBar}`
    : overlay
      ? `${styles.contextBar} ${styles.overlayContextBar}`
      : styles.contextBar;

  if (!dataset) {
    return (
      <div className={subHeaderClassName}>
        <div className={contextBarClassName}>
          <div className={styles.scopeBadge}>
            <span className={styles.scopeValue}>Loading...</span>
          </div>
          <span
            className={`${styles.actionButton} ${styles.homeButton} ${styles.disabledAction}`}
            aria-label="All maps"
            title="All maps"
          >
            <House size={14} />
          </span>
        </div>
      </div>
    );
  }

  const hasMultipleScopes = Array.isArray(scopes) && scopes.length > 1;
  const label = deriveCollectionLabel(dataset);
  const fallbackText = label.charAt(0).toUpperCase();

  return (
    <div className={subHeaderClassName}>
      <div className={contextBarClassName}>
        {onBack ? (
          <button className={`${styles.actionButton} ${styles.homeButton}`} onClick={onBack} aria-label="Back to map" title="Back to map">
            <ArrowLeft size={14} />
          </button>
        ) : (
          <Link to="/" className={`${styles.actionButton} ${styles.homeButton}`} aria-label="All maps" title="All maps">
            <House size={14} />
          </Link>
        )}
        <div className={styles.profilePill} title={label}>
          <ProfileAvatar
            profile={dataset?.profile}
            alt=""
            className={styles.avatar}
            fallbackClassName={styles.avatarFallback}
            fallbackText={fallbackText}
          />
          <span className={styles.profileLabel}>{label}</span>
        </div>

        {hasMultipleScopes && onScopeChange && (
          <div className={styles.scopeSelectWrap}>
            <select
              className={styles.scopeSelect}
              value={scope?.id || ''}
              onChange={onScopeChange}
            >
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label || s.id}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className={styles.scopeSelectIcon} />
          </div>
        )}
      </div>
    </div>
  );
};

SubNav.propTypes = {
  dataset: PropTypes.object,
  scope: PropTypes.object,
  scopes: PropTypes.array,
  onScopeChange: PropTypes.func,
  onBack: PropTypes.func,
  overlay: PropTypes.bool,
  embedded: PropTypes.bool,
};

export default SubNav;
