import { Link, useLocation } from 'react-router-dom';
import PropTypes from 'prop-types';
import styles from './SubNav.module.css';

const SubNav = ({ dataset }) => {
  const location = useLocation();

  if (!dataset) {
    return (
      <div className={styles.subHeaderContainer}>
        <div className={styles.tabsContainer}>
          <div className={styles.leftTabs}>
            <div className={styles.scopeBadge}>
              <span className={styles.scopeLabel}>Archive</span>
              <span className={styles.scopeValue}>Loading...</span>
            </div>
            <div className={styles.divider} />
            <span className={`${styles.tab} ${styles.disabledTab}`}>Import</span>
            <span className={`${styles.tab} ${styles.disabledTab}`}>View</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.subHeaderContainer}>
      <div className={styles.tabsContainer}>
        <div className={styles.leftTabs}>
          <div className={styles.scopeBadge}>
            <span className={styles.scopeLabel}>Archive</span>
            <span className={styles.scopeValue}>{dataset?.id || '-'}</span>
          </div>
          <div className={styles.divider} />
          <Link
            to="/import"
            className={`${styles.tab} ${location.pathname.includes('/import') ? styles.activeTab : ''}`}
          >
            Switch Archive
          </Link>
          <span className={styles.tab}>Knowledge View</span>
        </div>
      </div>
    </div>
  );
};

SubNav.propTypes = {
  dataset: PropTypes.object,
};

export default SubNav;
