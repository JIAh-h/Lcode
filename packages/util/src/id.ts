import { asCallId, asSessionId, type CallId, type SessionId } from './brand.ts'

/**
 * 全局唯一 id 生成（文档 22 §7.2：id 形态与全局唯一性）。
 * 26 字符 A-Z0-9（排除易混淆的 I/O/0/1），Crockford 风格 alphabet，nanoid 同款强度。
 * 会话 id 全局唯一（D17）。
 */

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const DEFAULT_LENGTH = 26

export function newId(length: number = DEFAULT_LENGTH): string {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes)
  } else {
    // Node < 20 无全局 crypto 时的回退（按文档要求 Node 22+ 基本不会走到）
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]!
  }
  return out
}

export function newSessionId(): SessionId {
  return asSessionId(newId())
}

export function newCallId(): CallId {
  return asCallId(newId(16))
}
