// Real visakanv tweets with mock topic clustering
// In production, this would come from the latent-scope API with actual cluster labels

import rawData from './visakanv_tweets_sample.json';

// Topic clusters (mock hierarchical structure based on common themes in visakanv's tweets)
const categories = [
  {
    id: 1,
    cluster: "0_0",
    label: "Writing and creative process",
    description: "Thoughts on writing, creativity, and the craft of putting ideas into words. Includes reflections on blogging, journaling, and the struggle to articulate complex thoughts.",
    layer: 0,
    count: 0,
    children: []
  },
  {
    id: 2,
    cluster: "0_1",
    label: "Self-improvement and personal growth",
    description: "Observations about habits, discipline, motivation, and becoming a better version of yourself. Often includes hard-won lessons and candid self-reflection.",
    layer: 0,
    count: 0,
    children: []
  },
  {
    id: 3,
    cluster: "0_2",
    label: "Social dynamics and relationships",
    description: "Insights about human connection, friendship, community, and navigating social situations. Includes thoughts on internet culture and online communities.",
    layer: 0,
    count: 0,
    children: []
  },
  {
    id: 4,
    cluster: "0_3",
    label: "Philosophy and meaning-making",
    description: "Deep dives into existential questions, finding purpose, and making sense of life. Often playful and irreverent while tackling serious topics.",
    layer: 0,
    count: 0,
    children: []
  },
  {
    id: 5,
    cluster: "0_4",
    label: "Work, productivity, and career",
    description: "Reflections on professional life, getting things done, and the nature of meaningful work. Includes thoughts on entrepreneurship and building things.",
    layer: 0,
    count: 0,
    children: []
  },
  {
    id: 6,
    cluster: "0_5",
    label: "Random musings and observations",
    description: "Miscellaneous thoughts, shower observations, and the kind of tweets that defy categorization. Often the most entertaining ones.",
    layer: 0,
    count: 0,
    children: []
  },
];

// Keywords to roughly categorize tweets (simple heuristic)
const categoryKeywords = {
  1: ['write', 'writing', 'blog', 'post', 'words', 'draft', 'essay', 'book', 'read', 'sentence', 'paragraph', 'thread'],
  2: ['habit', 'discipline', 'improve', 'better', 'learn', 'grow', 'change', 'goal', 'progress', 'practice', 'effort'],
  3: ['friend', 'people', 'social', 'community', 'talk', 'conversation', 'relationship', 'together', 'connect', 'online'],
  4: ['meaning', 'life', 'exist', 'purpose', 'think', 'thought', 'philosophy', 'truth', 'reality', 'consciousness', 'why'],
  5: ['work', 'job', 'career', 'business', 'product', 'ship', 'build', 'create', 'project', 'company', 'money'],
  6: [], // default bucket
};

function categorize(text) {
  const lowerText = text.toLowerCase();
  let maxScore = 0;
  let bestCategory = 6; // default to random musings

  for (const [catId, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.length === 0) continue;
    const score = keywords.filter(kw => lowerText.includes(kw)).length;
    if (score > maxScore) {
      maxScore = score;
      bestCategory = parseInt(catId);
    }
  }

  return bestCategory;
}

// Process tweets
function processData() {
  const tweets = rawData.tweets || rawData;
  const profile = rawData.profile || {
    username: "visakanv",
    display_name: "Visakan Veerasamy",
    avatar_url: "https://pbs.twimg.com/profile_images/1704988012006400000/K9qGAJF4_400x400.jpg"
  };

  // Categorize tweets
  const tweetsByCategory = {};
  categories.forEach(cat => {
    tweetsByCategory[cat.id] = [];
  });

  tweets.forEach(tweet => {
    const catId = categorize(tweet.text);
    tweetsByCategory[catId].push({
      id: tweet.id,
      author: {
        name: profile.display_name || profile.username,
        handle: `@${profile.username}`,
        avatar: profile.avatar_url,
      },
      text: tweet.text,
      timestamp: formatTimestamp(tweet.created_at),
      likes: tweet.favorite_count || 0,
      retweets: tweet.retweet_count || 0,
      replies: tweet.reply_count || 0,
      categoryId: catId,
    });
  });

  // Update category counts
  categories.forEach(cat => {
    cat.count = tweetsByCategory[cat.id].length;
  });

  // Sort tweets by likes within each category
  Object.keys(tweetsByCategory).forEach(catId => {
    tweetsByCategory[catId].sort((a, b) => b.likes - a.likes);
  });

  return { categories, tweetsByCategory, profile };
}

function formatTimestamp(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) return 'now';
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    if (diffDays < 365) return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

const processedData = processData();
const { tweetsByCategory, profile } = processedData;

export { categories, tweetsByCategory, profile };

export function getTweetsForCategory(categoryId, limit = 50) {
  return (tweetsByCategory[categoryId] || []).slice(0, limit);
}

export function getAllTweets() {
  return tweetsByCategory;
}
