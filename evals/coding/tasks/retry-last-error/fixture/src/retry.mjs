/**
 * 最多尝试 attempts 次；成功立即返回。
 * @template T
 * @param {() => Promise<T>} task
 * @param {number} attempts
 * @returns {Promise<T>}
 */
export async function retry(task, attempts) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await task()
    } catch (error) {
      if (i === attempts) throw error
    }
  }
}
