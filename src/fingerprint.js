import { createHash } from "node:crypto";

// 内容指纹：对规范化（键排序）后的 JSON 计算 sha256。
// 离线上传与重复回执按内容指纹归并；同一回执指纹相同即视为重复提交。
export function contentFingerprint(payload) {
  const canonical = canonicalize(payload);
  return "sha256:" + createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function canonicalize(value) {

  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}
