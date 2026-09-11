/**
 * 时间原语（D18：持久事件用 epoch ms（number）；展示层才做本地化）。
 * 时区不属于事实——持久层只存数字。
 */

/** 当前 epoch 毫秒（number，非 Date 对象） */
export function nowEpochMs(): number {
  return Date.now()
}

/** 校验一个值是否可作 epoch ms（有限非负 number，不变量 I5 兼容） */
export function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
