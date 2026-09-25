// 领域错误：携带机器可读代码，便于调用方区分冲突、越权、状态非法等情形。
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const ErrorCode = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  CONFLICT: "CONFLICT", // 乐观并发 / 版本冲突
  SCOPE_EXCEEDED: "SCOPE_EXCEEDED", // 转授权超出上级范围
  NOT_APPROVED: "NOT_APPROVED", // 转授权未经批准即生效
  INVALID_STATE: "INVALID_STATE",
  REVIEW_CONFLICT: "REVIEW_CONFLICT", // 并发复核相互覆盖
  DUPLICATE_RECEIPT: "DUPLICATE_RECEIPT",
  CONTENT_MISMATCH: "CONTENT_MISMATCH", // 同回执号但内容指纹不同
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
});

export function fail(code, message, details) {
  throw new DomainError(code, message, details);
}
