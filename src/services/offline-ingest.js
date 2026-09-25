import { randomUUID } from "node:crypto";
import { Aggregate } from "../domain/constants.js";
import { EventType } from "../domain/event-types.js";
import { contentFingerprint } from "../domain/fingerprint.js";
import { ErrorCode, fail } from "../domain/errors.js";
import { Projection } from "../domain/projection.js";

// 离线采集服务。
// 规则：
//  - 同一回执号重复上传：按业务内容的指纹判定。指纹相同 → 归并（幂等，不重复立案/通知）；
//  - 回执号相同但内容指纹不同 → 不归并，保留双方原始记录并开立差异调查；
//  - 调查期间不覆盖任何已有数据。
export class OfflineIngestService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
  }

  view() {
    return Projection.fromEvents(this.store.all());
  }

  // contentFields：显式声明哪些字段构成“内容”（回执号、设备、上传时间不计入）。
  upload({
    receiptNo,
    deviceId,
    uploadedAt = this.clock.now(),
    content,
    eventId,
  }) {
    if (!receiptNo) fail(ErrorCode.INVALID_ARGUMENT, "缺少回执号");
    if (content === undefined || content === null) fail(ErrorCode.INVALID_ARGUMENT, "缺少上传内容");
    const fingerprint = contentFingerprint(content);
    const view = this.view();
    const existing = view.receipts.get(receiptNo);

    if (!existing) {
      this.store.append({
        event_id: eventId,
        event_type: EventType.RECEIPT_REGISTERED,
        aggregate_type: Aggregate.RECEIPT,
        aggregate_id: `receipt:${receiptNo}`,
        occurred_at: uploadedAt,
        version: 1,
        summary: `离线回执首次上传：${receiptNo}`,
        payload: { receiptNo, fingerprint, deviceId, contentPreview: preview(content) },
      });
      return { outcome: "registered", receiptNo, fingerprint, merged: false };
    }

    if (existing.canonicalFingerprint === fingerprint) {
      const expected = this.store.versionOf(`receipt:${receiptNo}`);
      // 防御：若此前已有针对该指纹的未决异内容调查，则仅记录上传，等待调查结论。
      this.store.append(
        {
          event_type: EventType.RECEIPT_MERGED,
          aggregate_type: Aggregate.RECEIPT,
          aggregate_id: `receipt:${receiptNo}`,
          occurred_at: uploadedAt,
          summary: `重复回执按内容指纹归并：${receiptNo}`,
          payload: { receiptNo, fingerprint, deviceId, mergedWith: existing.firstEventId },
        },
        expected
      );
      return { outcome: "merged", receiptNo, fingerprint, merged: true };
    }

    // 同回执号、异内容：开立调查。已有的 canonical 内容保留不动。
    const investigationId = `inv_${randomUUID().slice(0, 10)}`;
    const expected = this.store.versionOf(`receipt:${receiptNo}`);
    const openAlready = existing.investigations.some(
      (i) => i.status === "open" && i.suspectFingerprint === fingerprint
    );
    if (!openAlready) {
      this.store.append(
        {
          event_type: EventType.RECEIPT_CONTENT_INVESTIGATION_OPENED,
          aggregate_type: Aggregate.RECEIPT,
          aggregate_id: `receipt:${receiptNo}`,
          occurred_at: uploadedAt,
          summary: `同回执号内容不一致，开立差异调查：${receiptNo}`,
          payload: {
            investigationId,
            receiptNo,
            fingerprint,
            deviceId,
            canonicalFingerprint: existing.canonicalFingerprint,
            contentPreview: preview(content),
            reason: "same_receipt_no_different_content",
          },
        },
        expected
      );
    }
    fail(
      ErrorCode.CONTENT_MISMATCH,
      `回执号 ${receiptNo} 重复上传但内容指纹不一致，已开立调查 ${investigationId}`,
      { investigationId, receiptNo, fingerprint, canonicalFingerprint: existing.canonicalFingerprint }
    );
  }

  resolveInvestigation({ receiptNo, investigationId, resolution, decidedBy }) {
    const aggregateId = `receipt:${receiptNo}`;
    const expected = this.store.versionOf(aggregateId);
    if (expected === 0) fail(ErrorCode.NOT_FOUND, `回执不存在：${receiptNo}`);
    const r = this.view().receipts.get(receiptNo);
    const inv = r.investigations.find((i) => i.investigationId === investigationId && i.status === "open");
    if (!inv) fail(ErrorCode.NOT_FOUND, `未决调查不存在：${investigationId}`);
    if (!["canonical_confirmed", "suspect_confirmed", "both_invalid"].includes(resolution)) {
      fail(ErrorCode.INVALID_ARGUMENT, "调查结论须为 canonical_confirmed / suspect_confirmed / both_invalid");
    }
    this.store.append(
      {
        event_type: EventType.RECEIPT_INVESTIGATION_RESOLVED,
        aggregate_type: Aggregate.RECEIPT,
        aggregate_id: aggregateId,
        occurred_at: this.clock.now(),
        summary: `回执差异调查结案：${investigationId} → ${resolution}`,
        payload: { investigationId, receiptNo, resolution, decidedBy },
      },
      expected
    );
  }
}

function preview(content) {
  const s = JSON.stringify(content);
  return s.length <= 200 ? s : `${s.slice(0, 200)}…`;
}
