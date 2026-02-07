import { memo } from 'react';
import { CornerDownRight, MessageSquare, GitBranch, Quote } from 'lucide-react';
import styles from './ConnectionBadges.module.scss';

function ConnectionBadges({ stats, onViewThread, onViewQuotes, compact = false }) {
  if (!stats) return null;

  const badges = [];

  // Priority 1: Reply indicator (this tweet replies to something)
  if (stats.threadDepth > 0 || stats.replyOutCount > 0) {
    badges.push({
      key: 'reply',
      type: 'thread',
      icon: CornerDownRight,
      label: 'Reply',
      action: onViewThread,
    });
  }

  // Priority 2: Thread root with multiple tweets
  if (stats.threadSize > 2 && stats.threadDepth === 0) {
    badges.push({
      key: 'thread',
      type: 'thread',
      icon: MessageSquare,
      label: `${stats.threadSize}-tweet thread`,
      action: onViewThread,
    });
  }

  // Priority 3: Has direct replies in dataset
  if (stats.replyChildCount > 0 && stats.threadDepth > 0) {
    // Already showing "Reply" badge — combine into thread size if available
    if (stats.threadSize > 2) {
      // Thread badge already shown — skip
    } else {
      badges.push({
        key: 'replies',
        type: 'thread',
        icon: GitBranch,
        label: `${stats.replyChildCount} ${stats.replyChildCount === 1 ? 'reply' : 'replies'}`,
        action: onViewThread,
      });
    }
  } else if (stats.replyChildCount > 0) {
    badges.push({
      key: 'replies',
      type: 'thread',
      icon: GitBranch,
      label: `${stats.replyChildCount} ${stats.replyChildCount === 1 ? 'reply' : 'replies'}`,
      action: onViewThread,
    });
  }

  // Priority 4: Quoted by others
  if (stats.quoteInCount > 0) {
    badges.push({
      key: 'quoted',
      type: 'quote',
      icon: Quote,
      label: `Quoted ${stats.quoteInCount}x`,
      action: onViewQuotes,
    });
  }

  // Priority 5: This tweet quotes others
  if (stats.quoteOutCount > 0) {
    badges.push({
      key: 'quotes',
      type: 'quote',
      icon: Quote,
      label: `Quotes ${stats.quoteOutCount}x`,
      action: onViewQuotes,
    });
  }

  // Limit to 3 badges max to avoid clutter
  const visibleBadges = badges.slice(0, 3);

  if (visibleBadges.length === 0) return null;

  return (
    <span className={`${styles.badges} ${compact ? styles.compact : ''}`}>
      {visibleBadges.map((badge) => {
        const Icon = badge.icon;
        const clickable = !!badge.action;
        const Tag = clickable ? 'button' : 'span';
        return (
          <Tag
            key={badge.key}
            className={`${styles.badge} ${styles[badge.type]}`}
            onClick={clickable ? (e) => {
              e.stopPropagation();
              badge.action();
            } : undefined}
            type={clickable ? 'button' : undefined}
          >
            <Icon size={11} />
            <span>{badge.label}</span>
          </Tag>
        );
      })}
    </span>
  );
}

export default memo(ConnectionBadges);
