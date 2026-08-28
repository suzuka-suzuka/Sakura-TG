export function getProfilePrefixes(profile) {
  if (!Array.isArray(profile?.prefixes)) return [];
  return profile.prefixes.filter(
    (prefix) => typeof prefix === "string" && prefix.length > 0
  );
}

export function getPrimaryPrefix(profile) {
  return getProfilePrefixes(profile)[0] || profile?.name || "";
}

export function matchProfilePrefix(profiles, text) {
  if (!Array.isArray(profiles) || typeof text !== "string") return null;

  const candidates = profiles
    .filter((profile) => profile?.enabled !== false)
    .flatMap((profile, profileIndex) =>
      getProfilePrefixes(profile).map((prefix, prefixIndex) => ({
        profile,
        prefix,
        profileIndex,
        prefixIndex,
      }))
    );

  candidates.sort(
    (a, b) =>
      b.prefix.length - a.prefix.length ||
      a.profileIndex - b.profileIndex ||
      a.prefixIndex - b.prefixIndex
  );
  return candidates.find(({ prefix }) => text.startsWith(prefix)) || null;
}

/** Build the current user text after a configured profile prefix matched. */
export function buildProfileTriggerQuery(match, text) {
  const input = String(text || "").trim();
  if (!match?.profile || typeof match.prefix !== "string") return input;
  if (match.profile.keepTriggerPrefix === true) return input;
  return input.slice(match.prefix.length).trim();
}
