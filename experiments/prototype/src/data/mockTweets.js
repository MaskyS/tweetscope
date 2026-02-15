export const categories = [
  {
    id: 1,
    label: "Discussions about climate policy and environmental regulations",
    description: "Conversations covering carbon taxes, renewable energy mandates, and international climate agreements. Includes debates on the effectiveness of various policy approaches and their economic implications for different industries and communities."
  },
  {
    id: 2,
    label: "Hot takes on the latest tech industry layoffs and hiring freezes",
    description: "Commentary on workforce reductions, startup pivots, and the state of the tech job market."
  },
  {
    id: 3,
    label: "Threads analyzing the implications of AI on creative industries",
    description: "Deep dives into how generative AI is reshaping art, music, writing, and design professions. Examining copyright concerns, the future of human creativity, economic disruption for artists, and the philosophical questions about what constitutes authentic creative expression in an age of machine-generated content."
  },
  {
    id: 4,
    label: "Community reactions to recent sports championship outcomes",
    description: "Fan celebrations, hot takes, and analysis from the latest major sporting events."
  },
  {
    id: 5,
    label: "Debates surrounding healthcare reform and insurance coverage",
    description: "Discussions on policy changes, coverage gaps, and the future of healthcare access. Topics include pharmaceutical pricing, mental health parity, rural healthcare deserts, the role of government vs private insurance, and comparative analysis of healthcare systems around the world."
  },
];

const avatars = [
  "https://i.pravatar.cc/150?img=1",
  "https://i.pravatar.cc/150?img=2",
  "https://i.pravatar.cc/150?img=3",
  "https://i.pravatar.cc/150?img=4",
  "https://i.pravatar.cc/150?img=5",
  "https://i.pravatar.cc/150?img=6",
  "https://i.pravatar.cc/150?img=7",
  "https://i.pravatar.cc/150?img=8",
];

const users = [
  { name: "Sarah Chen", handle: "@sarahchen" },
  { name: "Marcus Johnson", handle: "@marcusj" },
  { name: "Emily Rivera", handle: "@emriver" },
  { name: "David Kim", handle: "@davidkim" },
  { name: "Alex Thompson", handle: "@alexthompson" },
  { name: "Maya Patel", handle: "@mayapatel" },
  { name: "Chris Wong", handle: "@chriswong" },
  { name: "Jordan Lee", handle: "@jordanlee" },
];

const tweetTexts = {
  1: [
    "The new carbon pricing framework being proposed could fundamentally change how we approach industrial emissions. This is exactly what we needed 5 years ago.",
    "Just finished reading the latest IPCC report. The data on renewable adoption rates is actually more optimistic than I expected. Thread incoming.",
    "Hot take: Carbon offsets are just corporate greenwashing unless they're paired with actual emissions reductions. Change my mind.",
    "The EU's new environmental regulations are setting a global standard. Other countries will have to follow or face trade consequences.",
    "Visited a solar farm today. The scale of these installations is mind-blowing. We're really seeing the energy transition happen in real-time.",
    "The pushback against wind farms in rural areas is frustrating. NIMBYism is going to slow down our climate goals significantly.",
  ],
  2: [
    "Another round of layoffs at a major tech company. When will the industry realize that hire-fast-fire-fast isn't sustainable?",
    "Just got laid off after 7 years. The job market right now is brutal. Anyone hiring senior engineers?",
    "Interesting pattern: companies laying off workers while simultaneously complaining about talent shortages. Make it make sense.",
    "The startup I joined 6 months ago just announced a pivot. Third time this has happened to me. Maybe I should stick to big tech.",
    "Hiring freezes are hitting junior developers the hardest. How are new grads supposed to break into the industry?",
    "The irony of tech companies using AI to automate away the jobs of people who built AI is not lost on me.",
  ],
  3: [
    "Spent the weekend experimenting with AI art tools. As a traditional artist, I'm both terrified and fascinated by the possibilities.",
    "The argument that 'AI is just a tool' ignores the fact that it's a tool trained on artists' work without consent or compensation.",
    "Hot take: AI-generated content will become so ubiquitous that human-made art will become more valuable, not less.",
    "Just used AI to help write my first draft. It's not replacing creativity, it's augmenting it. The key is knowing when to use it.",
    "The music industry's response to AI is going to determine whether we have a creative renaissance or an artistic apocalypse.",
    "Watching AI recreate famous artists' styles raises serious questions about intellectual property in the digital age.",
  ],
  4: [
    "WHAT A GAME! Still can't believe that comeback in the fourth quarter. Championship moments don't get better than this!",
    "The refs absolutely handed that game away. I don't care what anyone says, that was a terrible call in the final minutes.",
    "This dynasty isn't over. They'll be back next year stronger than ever. Mark my words.",
    "First championship in 40 years and I'm crying at a sports bar surrounded by strangers who are now family. Sports are beautiful.",
    "The post-game press conference was more entertaining than the game itself. That coach has no filter and I'm here for it.",
    "Already seeing championship merchandise everywhere. The economic impact of these wins on local businesses is real.",
  ],
  5: [
    "My insurance just denied a procedure my doctor said I need. The appeals process is designed to make you give up. Don't give up.",
    "The gap between what healthcare costs and what people can afford to pay keeps growing. Something has to change.",
    "Just watched a documentary on healthcare systems around the world. We're doing so many things wrong but also some things right.",
    "Preventive care saves money in the long run but insurers still fight against covering it. The incentives are completely misaligned.",
    "The mental health crisis is a healthcare crisis. Until we treat it that way, we're not going to make real progress.",
    "Medical debt shouldn't exist. The fact that illness can bankrupt families in the wealthiest country in the world is absurd.",
  ],
};

const timestamps = ["2m", "15m", "1h", "2h", "4h", "8h", "12h", "1d"];

function getRandomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateTweet(id, categoryId) {
  const userIndex = Math.floor(Math.random() * users.length);
  return {
    id: `${categoryId}-${id}`,
    author: {
      name: users[userIndex].name,
      handle: users[userIndex].handle,
      avatar: avatars[userIndex],
    },
    text: getRandomItem(tweetTexts[categoryId]),
    timestamp: getRandomItem(timestamps),
    likes: Math.floor(Math.random() * 500) + 10,
    retweets: Math.floor(Math.random() * 100) + 5,
    categoryId,
  };
}

export function getTweetsForCategory(categoryId, count = 8) {
  return Array.from({ length: count }, (_, i) => generateTweet(i, categoryId));
}

export function getAllTweets() {
  const allTweets = {};
  categories.forEach(cat => {
    allTweets[cat.id] = getTweetsForCategory(cat.id);
  });
  return allTweets;
}
