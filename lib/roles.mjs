/** An omitted setting preserves existing NVR installs; an explicit empty setting monitors only. */
export function nodeRoles(value) {
  if (value === undefined) return ["storage", "stream"];
  if (typeof value !== "string") throw new Error("Invalid roles");
  if (!value.trim()) return [];
  const roles = value.split(",").map((role) => role.trim());
  if (roles.some((role) => !["storage", "stream"].includes(role)))
    throw new Error("Invalid roles");
  return [...new Set(roles)];
}
