/**
 * 最多尝试 attempts 次；成功立即返回。
 * @template T
 * @param {() => Promise<T>} task
 * @param {number} attempts
 * @returns {Promise<T>}
 */
export async function retry(task, attempts) {
  if (!Number.isInteger(attempts) || attempts <= 0) {
    throw new TypeError('attempts must be a positive integer')
  }
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
