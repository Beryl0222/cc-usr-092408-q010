import { randomUUID } from "node:crypto";
import { Aggregate } from "../domain/constants.js";
import { EventType } from "../domain/event-types.js";
import { ErrorCode, fail } from "../domain/errors.js";

// 建档服务：品牌授权、经营主体、门店、品类、标准版本分别建档，互不顶替。
export class ProfileService {
  constructor(store, clock) {
    this.store = store;
    this.clock = clock;
  }

  registerBrand({ brandId, name, officeName, ...rest }) {
    if (this.store.versionOf(brandId) > 0) fail(ErrorCode.ALREADY_EXISTS, `品牌已建档：${brandId}`);
    this.store.append({
      event_id: rest.eventId,
      event_type: EventType.BRAND_REGISTERED,
      aggregate_type: Aggregate.BRAND,
      aggregate_id: brandId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `公用品牌建档：${name}`,
      payload: { name, officeName, ...without(rest, ["eventId"]) },
    });
    return brandId;
  }

  registerOperator({ operatorId, name, creditCode, legalRepresentative, ...rest }) {
    if (this.store.versionOf(operatorId) > 0) fail(ErrorCode.ALREADY_EXISTS, `经营主体已建档：${operatorId}`);
    this.store.append({
      event_id: rest.eventId,
      event_type: EventType.OPERATOR_REGISTERED,
      aggregate_type: Aggregate.OPERATOR,
      aggregate_id: operatorId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `经营主体建档：${name}`,
      payload: { name, creditCode, legalRepresentative, ...without(rest, ["eventId"]) },
    });
    return operatorId;
  }

  registerStore({ storeId, brandId, name, address, ...rest }) {
    if (this.store.versionOf(storeId) > 0) fail(ErrorCode.ALREADY_EXISTS, `门店已建档：${storeId}`);
    this.store.append({
      event_id: rest.eventId,
      event_type: EventType.STORE_REGISTERED,
      aggregate_type: Aggregate.STORE,
      aggregate_id: storeId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `门店（档口）建档：${name}`,
      payload: { brandId, name, address, ...without(rest, ["eventId"]) },
    });
    return storeId;
  }

  registerCategory({ categoryId, brandId, name, ...rest }) {
    if (this.store.versionOf(categoryId) > 0) fail(ErrorCode.ALREADY_EXISTS, `品类已建档：${categoryId}`);
    this.store.append({
      event_id: rest.eventId,
      event_type: EventType.CATEGORY_REGISTERED,
      aggregate_type: Aggregate.CATEGORY,
      aggregate_id: categoryId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `适用品类建档：${name}`,
      payload: { brandId, name, ...without(rest, ["eventId"]) },
    });
    return categoryId;
  }

  // 标准版本独立建档；换版产生新版本，旧版本保留以绑定历史巡检证据。
  publishStandard({ standardId, brandId, versionNo, title, effectiveFrom, clauses, ...rest }) {
    if (this.store.versionOf(standardId) > 0) fail(ErrorCode.ALREADY_EXISTS, `标准版本已存在：${standardId}`);
    this.store.append({
      event_id: rest.eventId,
      event_type: EventType.STANDARD_PUBLISHED,
      aggregate_type: Aggregate.STANDARD,
      aggregate_id: standardId,
      occurred_at: this.clock.now(),
      version: 1,
      summary: `标准版本发布：${title} ${versionNo}`,
      payload: {
        brandId,
        versionNo,
        title,
        effectiveFrom,
        clauses: clauses ?? [],
        ...without(rest, ["eventId"]),
      },
    });
    return standardId;
  }

  deprecateStandard(standardId, { reason } = {}) {
    const expected = this.store.versionOf(standardId);
    if (expected === 0) fail(ErrorCode.NOT_FOUND, `标准版本不存在：${standardId}`);
    this.store.append(
      {
        event_type: EventType.STANDARD_DEPRECATED,
        aggregate_type: Aggregate.STANDARD,
        aggregate_id: standardId,
        occurred_at: this.clock.now(),
        summary: `标准版本废止：${standardId}`,
        payload: { reason },
      },
      expected
    );
  }
}

function without(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

export function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}
