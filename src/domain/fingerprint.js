import { createHash } from "node:crypto";

// 稳定序列化：对象键按字典序排列，保证同一语义内容在不同进程/录入顺序下指纹一致。
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// 内容指纹：只归并业务内容，不纳入回执号、录入时间、设备等信封字段。
// 调用方通过 pickContent 显式声明哪些字段属于“内容”。
export function contentFingerprint(content) {
  return "sha256:" + createHash("sha256").update(stableStringify(content), "utf8").digest("hex");
}
