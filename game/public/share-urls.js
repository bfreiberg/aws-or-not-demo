// Pure: imported by the server-rendered result page and by the in-game client.
export function shareUrls({ url, text }) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  return {
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    x: `https://x.com/intent/post?text=${t}&url=${u}`,
    bluesky: `https://bsky.app/intent/compose?text=${encodeURIComponent(`${text} ${url}`)}`,
  };
}

export const shareText = ({ score, rank, mode }) =>
  `I scored ${score} on AWS or Not? (${mode === 'hard' ? 'Hard' : 'Normal'} mode) and reached ${rank}. Can you tell real AWS services from made-up ones?`;
