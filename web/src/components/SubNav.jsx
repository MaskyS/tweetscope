import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import styles from './SubNav.module.css';

const SubNav = ({ dataset }) => {
  if (!dataset) {
    return (
      <div className={styles.subHeaderContainer}>
        <div className={styles.contextBar}>
          <div className={styles.scopeBadge}>
            <span className={styles.scopeLabel}>Archive</span>
            <span className={styles.scopeValue}>Loading...</span>
          </div>
          <span className={`${styles.actionButton} ${styles.disabledAction}`}>
            Switch Archive
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.subHeaderContainer}>
      <div className={styles.contextBar}>
        <div className={styles.scopeBadge}>
          <span className={styles.scopeLabel}>Archive</span>
          <span className={styles.scopeValue}>{dataset?.id || '-'}</span>
        </div>
        <Link to="/import" className={styles.actionButton}>
          Switch Archive
        </Link>
      </div>
    </div>
  );
};

SubNav.propTypes = {
  dataset: PropTypes.object,
};

export default SubNav;
