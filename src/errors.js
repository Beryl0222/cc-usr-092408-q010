// 领域错误：携带机器可读 code，便于调用方与测试区分冲突类型。
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.entries = details.entries;
    this.conflicts = details.conflicts;
    this.relatedIds = details.relatedIds;
    this.detail = details.detail;
  }
}

export const fail = (code, message, details) => {
  throw new DomainError(code, message, details);
};
