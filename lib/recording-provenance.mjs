/** Archive metadata never promotes an old packet copy to a trusted normalized original. */
export function recordingProvenance(info) {
  if (!info || typeof info !== "object" || Array.isArray(info)) return {};
  const value = {};
  for (const key of ["originalCompatible", "compatibilityRepaired"])
    if (typeof info[key] === "boolean") value[key] = info[key];
  if (info.originalPolicyVersion === 1) value.originalPolicyVersion = 1;
  const source = info.originalProvenance;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    if (source.kind === "haus-encoder" && source.profile === 1)
      value.originalProvenance = { kind: "haus-encoder", profile: 1 };
    else if (source.kind === "camera") {
      value.originalProvenance = { kind: "camera" };
      for (const key of ["platform", "manufacturer", "model"])
        if (typeof source[key] === "string")
          value.originalProvenance[key] = source[key]
            .replace(/[\x00-\x1f]/g, "")
            .slice(0, 160);
    }
  }
  return value;
}
