/** 比较两个 ISO 日期是否为同一自然日（忽略时分秒），相等返回 0，a 早于 b 返回 -1 */
export function sameDay(a: string, b: string): number {
  const da = a.slice(0, 10);
  const db = b.slice(0, 10);
  if (da === db) return 0;
  return da < db ? -1 : 1;
}
