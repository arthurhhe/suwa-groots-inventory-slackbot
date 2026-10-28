// Maps names written in the sheet's config row (e.g. "@dana") to Slack user IDs.
// The user list is fetched by the caller (users.list) so this stays pure and testable.

export interface SlackUser {
  id: string;
  name: string;
  displayName: string;
  realName: string;
}

export interface MentionResolution {
  mentions: string[];
  unresolved: string[];
}

export function resolveMentions(names: string[], users: SlackUser[]): MentionResolution {
  const mentions: string[] = [];
  const unresolved: string[] = [];
  for (const raw of names) {
    const wanted = raw.trim().replace(/^@/, "").toLowerCase();
    const match = users.find((u) =>
      [u.name, u.displayName, u.realName].some((candidate) => candidate.trim().toLowerCase() === wanted),
    );
    if (match) mentions.push(`<@${match.id}>`);
    else unresolved.push(`@${raw.trim().replace(/^@/, "")}`);
  }
  return { mentions, unresolved };
}
