import { fail } from "./errors.js";
import { contentFingerprint } from "./fingerprint.js";
import { assertNonEmptyScope, assertScopeKnown, covers } from "./scope.js";

// 分别建档：品牌授权、经营主体、门店（含档口）、品类、标准版本、人员角色。
// 每一类都是独立聚合，档案事件只追加、不改写。

export function createRegistry(store) {
  function append(eventType, aggregateType, aggregateId, payload, actor, expectedVersion, occurredAt) {
    return store.append({ eventType, aggregateType, aggregateId, payload, actor: actor?.staffId ?? null, expectedVersion, occurredAt });
  }

  return {
    registerBrand({ brandId, name }, actor) {
      if (store.history(brandId).length) fail("ALREADY_EXISTS", `品牌已建档：${brandId}`);
      return append("BRAND_REGISTERED", "brand", brandId, { name }, actor);
    },

    registerSubject({ subjectId, name, subjectType = "operator" }, actor) {
      if (store.history(subjectId).length) fail("ALREADY_EXISTS", `经营主体已建档：${subjectId}`);
      return append("SUBJECT_REGISTERED", "subject", subjectId, { name, subjectType }, actor);
    },

    registerStore({ storeId, name, address, brandId }, actor) {
      if (store.history(storeId).length) fail("ALREADY_EXISTS", `门店已建档：${storeId}`);
      if (brandId && !store.history(brandId).some((e) => e.event_type === "BRAND_REGISTERED")) {
        fail("UNKNOWN_BRAND", `品牌未建档：${brandId}`);
      }
      return append("STORE_REGISTERED", "store", storeId, { name, address: address ?? null, brandId: brandId ?? null }, actor);
    },

    registerCategory({ categoryId, name }, actor) {
      if (store.history(categoryId).length) fail("ALREADY_EXISTS", `品类已建档：${categoryId}`);
      return append("CATEGORY_REGISTERED", "category", categoryId, { name }, actor);
    },

    registerStaff({ staffId, name, roles }, actor) {
      if (!Array.isArray(roles) || roles.length === 0) fail("INVALID_ROLE", "人员至少需要一个角色");
      if (store.history(staffId).length) fail("ALREADY_EXISTS", `人员已建档：${staffId}`);
      return append("STAFF_REGISTERED", "staff", staffId, { name, roles }, actor);
    },

    // 标准版本建档：内容指纹随版本固定，巡检时绑定的就是这一不可变快照。
    publishStandard({ standardVersionId, brandId = null, title, versionNo, effectiveFrom, items = [] }, actor, occurredAt) {
      if (store.history(standardVersionId).length) fail("ALREADY_EXISTS", `标准版本已建档：${standardVersionId}`);
      const body = { title, versionNo, items };
      return append(
        "STANDARD_VERSION_PUBLISHED",
        "standard_version",
        standardVersionId,
        {
          brandId,
          title,
          versionNo,
          effectiveFrom,
          items,
          contentFingerprint: contentFingerprint(body),
        },
        actor,
        undefined,
        occurredAt
      );
    },

    supersedeStandard({ standardVersionId, supersededBy }, actor, occurredAt) {
      const history = store.history(standardVersionId);
      if (!history.some((e) => e.event_type === "STANDARD_VERSION_PUBLISHED")) {
        fail("NOT_FOUND", `标准版本未建档：${standardVersionId}`);
      }
      if (history.some((e) => e.event_type === "STANDARD_VERSION_SUPERSEDED")) {
        fail("ALREADY_SUPERSEDED", `标准版本已被替代：${standardVersionId}`);
      }
      return append(
        "STANDARD_VERSION_SUPERSEDED",
        "standard_version",
        standardVersionId,
        { supersededBy },
        actor,
        undefined,
        occurredAt
      );
    },

    // 档口实际经营者登记/变更。主体变化是追加事实，不覆盖历史责任。
    changeStallOperator({ storeId, stallId, toSubjectId, changedAt, note = null, evidence = [] }, actor) {
      const store_ = store.history(storeId);
      if (!store_.some((e) => e.event_type === "STORE_REGISTERED")) fail("UNKNOWN_STORE", `门店未建档：${storeId}`);
      if (!store.history(toSubjectId).some((e) => e.event_type === "SUBJECT_REGISTERED")) {
        fail("UNKNOWN_SUBJECT", `经营主体未建档：${toSubjectId}`);
      }
      const state = foldStore(store_);
      const fromSubjectId = state.stalls.get(stallId)?.operatorSubjectId ?? null;
      if (fromSubjectId === toSubjectId) fail("NO_CHANGE", "档口实际经营者未发生变化");
      return append(
        "STALL_OPERATOR_CHANGED",
        "store",
        storeId,
        {
          stallId,
          fromSubjectId,
          toSubjectId,
          changedAt,
          note,
          evidence: evidence.map((e) => ({ ...e, fingerprint: e.fingerprint ?? contentFingerprint(e) })),
        },
        actor
      );
    },
  };
}

export function requireRole(actor, role) {
  if (!actor || !Array.isArray(actor.roles) || !actor.roles.includes(role)) {
    fail("FORBIDDEN", `该操作要求角色：${role}`);
  }
}

// ---- 只读建档查询（供其他服务复用） ----

export function foldBrand(events) {
  let brand = null;
  for (const e of events) if (e.event_type === "BRAND_REGISTERED") brand = { brandId: e.aggregate_id, ...e.payload };
  return brand;
}

export function foldSubject(events) {
  let subject = null;
  for (const e of events) if (e.event_type === "SUBJECT_REGISTERED") subject = { subjectId: e.aggregate_id, ...e.payload };
  return subject;
}

export function foldCategory(events) {
  let category = null;
  for (const e of events) if (e.event_type === "CATEGORY_REGISTERED") category = { categoryId: e.aggregate_id, ...e.payload };
  return category;
}

export function foldStaff(events) {
  let staff = null;
  for (const e of events) if (e.event_type === "STAFF_REGISTERED") staff = { staffId: e.aggregate_id, ...e.payload };
  return staff;
}

export function foldStore(events) {
  let store = null;
  const stalls = new Map();
  const operatorTimeline = [];
  for (const e of events) {
    if (e.event_type === "STORE_REGISTERED") {
      store = { storeId: e.aggregate_id, ...e.payload, stalls, operatorTimeline };
    } else if (e.event_type === "STALL_OPERATOR_CHANGED") {
      const p = e.payload;
      const prev = stalls.get(p.stallId);
      if (prev) prev.until = p.changedAt;
      stalls.set(p.stallId, { stallId: p.stallId, operatorSubjectId: p.toSubjectId, since: p.changedAt, until: null });
      operatorTimeline.push({ ...p });
    }
  }
  if (store) store.stalls = stalls;
  return store;
}

// 解析某档口在指定时间点的实际经营主体。
// 主体变化只追加事实：历史区间的责任主体始终可回溯，不会因换经营者而被改写。
export function operatorAt(store, stallId, at) {
  if (!store) return null;
  const atIso = at instanceof Date ? at.toISOString() : at;
  const changes = store.operatorTimeline
    .filter((t) => t.stallId === stallId)
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  // 取 changedAt <= at 的最后一次变更。
  let current = null;
  for (const ch of changes) {
    if (ch.changedAt <= atIso) current = ch.toSubjectId;
    else break;
  }
  return current;
}

// 该档口历任经营主体（去重，按时间顺序），用于保留此前责任。
export function pastOperators(store, stallId) {
  if (!store) return [];
  const seen = new Set();
  const out = [];
  for (const t of [...store.operatorTimeline]
    .filter((x) => x.stallId === stallId)
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt))) {
    for (const id of [t.fromSubjectId, t.toSubjectId]) {
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export function foldStandard(events) {
  let standard = null;
  for (const e of events) {
    if (e.event_type === "STANDARD_VERSION_PUBLISHED") {
      standard = { standardVersionId: e.aggregate_id, status: "active", ...e.payload };
    } else if (e.event_type === "STANDARD_VERSION_SUPERSEDED") {
      standard = { ...standard, status: "superseded", supersededBy: e.payload.supersededBy };
    }
  }
  return standard;
}

// 档案总表：所有访问器都实时从事件存储折叠，保证应用长生命周期内能看到最新建档。
export function buildRegistryIndex(store) {
  function aggregateIdsOfType(type) {
    const ids = [];
    for (const e of store.all()) if (e.aggregate_type === type && !ids.includes(e.aggregate_id)) ids.push(e.aggregate_id);
    return ids;
  }

  const api = {
    brand: (id) => foldBrand(store.history(id)),
    subject: (id) => foldSubject(store.history(id)),
    store: (id) => foldStore(store.history(id)),
    category: (id) => foldCategory(store.history(id)),
    standard: (id) => foldStandard(store.history(id)),
    staff: (id) => foldStaff(store.history(id)),
    brands: () => aggregateIdsOfType("brand").map((id) => api.brand(id)).filter(Boolean),
    subjects: () => aggregateIdsOfType("subject").map((id) => api.subject(id)).filter(Boolean),
    stores: () => aggregateIdsOfType("store").map((id) => api.store(id)).filter(Boolean),
    categories: () => aggregateIdsOfType("category").map((id) => api.category(id)).filter(Boolean),
    standards: () => aggregateIdsOfType("standard_version").map((id) => api.standard(id)).filter(Boolean),
    staffMembers: () => aggregateIdsOfType("staff").map((id) => api.staff(id)).filter(Boolean),
    resolveActor(actor) {
      if (!actor?.staffId) return actor ?? null;
      const record = api.staff(actor.staffId);
      if (!record) fail("UNKNOWN_STAFF", `人员未建档：${actor.staffId}`);
      return { staffId: record.staffId, name: record.name, roles: record.roles };
    },
    assertScope(scope) {
      assertNonEmptyScope(scope);
      assertScopeKnown(scope, api);
    },
  };
  return api;
}
