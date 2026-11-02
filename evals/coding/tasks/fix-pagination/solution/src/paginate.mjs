/**
 * 1-based 分页：page=1 返回第一页。
 * @param {readonly unknown[]} items
 * @param {number} page
 * @param {number} pageSize
 */
export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize
  return items.slice(start, start + pageSize)
}
