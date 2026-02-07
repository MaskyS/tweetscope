import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import ThreadView from '../ThreadView/ThreadView';
import styles from './ThreadOverlay.module.scss';

export default function ThreadOverlay({
  open,
  dataset,
  tweetId,
  currentLsIndex,
  nodeStats,
  clusterMap,
  onClose,
  onViewThread,
  onViewQuotes,
}) {
  return (
    <AnimatePresence>
      {open && tweetId && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <motion.aside
            className={styles.panel}
            initial={{ x: 560 }}
            animate={{ x: 0 }}
            exit={{ x: 560 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          >
            <div className={styles.header}>
              <h3 className={styles.title}>Thread</h3>
              <button className={styles.closeButton} type="button" onClick={onClose} aria-label="Close thread overlay">
                <X size={16} />
              </button>
            </div>
            <div className={styles.content}>
              <ThreadView
                datasetId={dataset?.id}
                tweetId={tweetId}
                currentLsIndex={currentLsIndex}
                nodeStats={nodeStats}
                clusterMap={clusterMap}
                dataset={dataset}
                onBack={onClose}
                onViewThread={onViewThread}
                onViewQuotes={onViewQuotes}
                showHeader={false}
              />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
