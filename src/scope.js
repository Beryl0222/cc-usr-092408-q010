import { fail } from "./errors.js";

// 授权范围用「门店集合 × 品类集合」的矩形表示（建档/授予）；
// 但暂停/恢复是精确到「门店×品类」格点的：停售 st1 的面食，
// 不应被放大成「所有门店的面食」或「st1 的所有品类」。

export const cellKey = (storeId, categoryId) => `${storeId}::${categoryId}`;

// 矩形范围展开为格点键集合。
export function cells(scope) {
  const out = new Set();
  for (const s of scope.stores) for (const c of scope.categories) out.add(cellKey(s, c));
  return out;
}

export function parseCell(key) {
  const idx = key.indexOf("::");
  return { store: key.slice(0, idx), category: key.slice(idx + 2) };
}

export function scopeOfCells(cellSet) {
  const stores = new Set();
  const categories = new Set();
  for (const key of cellSet) {
    const { store, category } = parseCell(key);
    stores.add(store);
    categories.add(category);
  }
  return { stores: [...stores], categories: [...categories] };
}

// 矩形包含：下级矩形是否完全落在上级矩形内（两个轴都要被覆盖）。
export function covers(parent, child) {
  return coversAxis(parent.stores, child.stores) && coversAxis(parent.categories, child.categories);
}

export function coversAxis(parentValues, childValues) {
  if (parentValues.includes("*")) return true;
  if (childValues.includes("*")) return false;
  const parentSet = new Set(parentValues);
  return childValues.every((v) => parentSet.has(v));
}

export function intersect(a, b) {
  return {
    stores: intersectAxis(a.stores, b.stores),
    categories: intersectAxis(a.categories, b.categories),
  };
}

function intersectAxis(a, b) {
  if (a.includes("*")) return [...b];
  if (b.includes("*")) return [...a];
  const bSet = new Set(b);
  return a.filter((v) => bSet.has(v));
}

// 两矩形的格点交集。
export function intersectCells(a, b) {
  const out = new Set();
  for (const key of cells(a)) if (cells(b).has(key)) out.add(key);
  return out;
}

export function subtractCells(grantedCells, removedCells) {
  const out = new Set(grantedCells);
  for (const key of removedCells) out.delete(key);
  return out;
}

// 上级能否把某范围转授给下级：
//  1) 不超出上级授予矩形；2) 范围内每个格点当前都未被暂停/吊销。
export function canDelegate(parentLicense, childScope) {
  if (!covers(parentLicense.scope, childScope)) return false;
  const blocked = parentLicense.suspendedCells ?? new Set();
  for (const key of cells(childScope)) if (blocked.has(key)) return false;
  return true;
}

export function scopeKey(scope) {
  return [...scope.stores].sort().join("|") + "##" + [...scope.categories].sort().join("|");
}

export function assertNonEmptyScope(scope) {
  if (!scope || !Array.isArray(scope.stores) || !Array.isArray(scope.categories)) {
    fail("INVALID_SCOPE", "授权范围必须包含 stores 与 categories 两个数组");
  }
  if (scope.stores.length === 0 || scope.categories.length === 0) {
    fail("INVALID_SCOPE", "授权范围的门店与品类均不能为空");
  }
}

export function assertScopeKnown(scope, registry) {
  for (const storeId of scope.stores) {
    if (storeId !== "*" && !registry.store(storeId)) fail("UNKNOWN_STORE", `门店未建档：${storeId}`);
  }
  for (const categoryId of scope.categories) {
    if (categoryId !== "*" && !registry.category(categoryId)) {
      fail("UNKNOWN_CATEGORY", `品类未建档：${categoryId}`);
    }
  }
}
