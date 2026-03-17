import assert from 'node:assert/strict';
import test from 'node:test';

import { getProfileAvatarCandidates } from './profileAvatar.js';

test('getProfileAvatarCandidates prefers the stored avatar and adds a username fallback', () => {
  assert.deepEqual(
    getProfileAvatarCandidates({
      avatar_url: 'https://pbs.twimg.com/profile_images/example.jpg',
      username: 'visakanv',
    }),
    [
      'https://pbs.twimg.com/profile_images/example.jpg',
      'https://unavatar.io/x/visakanv',
    ]
  );
});

test('getProfileAvatarCandidates strips leading @ and dedupes identical URLs', () => {
  assert.deepEqual(
    getProfileAvatarCandidates({
      avatar_url: 'https://unavatar.io/x/nosilverv',
      username: '@nosilverv',
    }),
    ['https://unavatar.io/x/nosilverv']
  );
});

test('getProfileAvatarCandidates returns an empty list when no avatar inputs exist', () => {
  assert.deepEqual(getProfileAvatarCandidates({}), []);
});
