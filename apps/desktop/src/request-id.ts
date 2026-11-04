// RFC 9562 UUIDv7: Unix milliseconds plus 74 random bits. No command data is encoded.
// Clock rollback is handled by the service's fail-closed retention window, never by replay.
export function requestId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new Error('系统时间超出请求 ID 范围。');
  const random = crypto.randomUUID().replaceAll('-', '');
  const value = now.toString(16).padStart(12, '0') + '7' + random.slice(13);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
