import { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';

import { getProfileAvatarCandidates } from '../lib/profileAvatar';

function ProfileAvatar({
  profile,
  alt = '',
  className,
  fallbackClassName,
  fallbackText,
  loading = 'lazy',
  decoding = 'async',
}) {
  const candidates = useMemo(() => getProfileAvatarCandidates(profile), [profile]);
  const candidateKey = candidates.join('|');
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
  }, [candidateKey]);

  const currentUrl = candidates[candidateIndex];
  if (currentUrl) {
    return (
      <img
        src={currentUrl}
        alt={alt}
        className={className}
        loading={loading}
        decoding={decoding}
        onError={() => {
          setCandidateIndex((current) => current + 1);
        }}
      />
    );
  }

  if (!fallbackClassName) return null;

  return <div className={fallbackClassName}>{fallbackText}</div>;
}

ProfileAvatar.propTypes = {
  profile: PropTypes.shape({
    username: PropTypes.string,
    avatar_url: PropTypes.string,
  }),
  alt: PropTypes.string,
  className: PropTypes.string,
  fallbackClassName: PropTypes.string,
  fallbackText: PropTypes.node,
  loading: PropTypes.oneOf(['eager', 'lazy']),
  decoding: PropTypes.oneOf(['sync', 'async', 'auto']),
};

export default ProfileAvatar;
