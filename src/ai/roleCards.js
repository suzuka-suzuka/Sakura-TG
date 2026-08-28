export function resolveRoleCardPrompt(profile, roleCards = []) {
  const name = String(profile?.name || "").trim();
  if (!name || !Array.isArray(roleCards)) return "";

  const roleCard = roleCards.find(
    (candidate) => String(candidate?.name || "").trim() === name
  );
  return String(roleCard?.prompt || "").trim();
}
