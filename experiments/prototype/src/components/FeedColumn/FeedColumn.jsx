import TweetCard from '../TweetCard/TweetCard';
import styles from './FeedColumn.module.scss';

export default function FeedColumn({ tweets, focusState, columnWidth }) {
  const stateClass = {
    focused: styles.focused,
    adjacent: styles.adjacent,
    far: styles.far,
  }[focusState] || '';

  return (
    <div
      className={`${styles.column} ${stateClass}`}
      style={{ width: columnWidth }}
    >
      <div className={styles.tweetList}>
        {tweets.map(tweet => (
          <TweetCard key={tweet.id} tweet={tweet} />
        ))}
      </div>
    </div>
  );
}
