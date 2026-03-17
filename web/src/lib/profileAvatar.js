export function getProfileAvatarCandidates(profile) {
  const candidates = [];

  const directAvatarUrl = profile?.avatar_url?.trim();
  if (directAvatarUrl) {
    candidates.push(directAvatarUrl);
  }

  const username = profile?.username?.trim().replace(/^@+/, '');
  if (username) {
    candidates.push(`https://unavatar.io/x/${encodeURIComponent(username)}`);
  }

  return [...new Set(candidates)];
}
