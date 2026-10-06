import { splitApiKeys } from '../../shared/model-providers';

/**
 * 从逗号分隔的多个 API Key 中随机选择一个。
 * 如果只有一个 key 或为空，直接返回原值。
 */
export function pickApiKey(keys: string): string {
  // 拆分规则与「测试连接逐把验证」、设置页密钥行同源（shared），
  // 否则会出现「测的是 A、用的是 A,B」这类假阳性/假阴性。
  const parts = splitApiKeys(keys);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  // 随机选择一个
  const idx = Math.floor(Math.random() * parts.length);
  return parts[idx];
}

/**
 * 加权随机：按权重比例从复合提供商的成员中挑选一个。
 *
 * 权重负载均衡：成员被选中的概率 = 该成员权重 / 总权重。
 * 例如成员权重 [2, 1, 1] → 第一个成员被选中的概率为 50%。
 *
 * @param members 成员列表（已过滤：成员存在、已启用、支持该模型）
 * @returns 选中的成员；列表为空时返回 undefined
 */
export function pickWeightedMember<T extends { weight?: number }>(
  members: T[],
): T | undefined {
  const valid = members.filter((m) => typeof m.weight === 'number' && m.weight > 0);
  if (valid.length === 0) return members[0]; // 兜底：权重全无效时均匀随机
  const total = valid.reduce((s, m) => s + (m.weight ?? 1), 0);
  let r = Math.random() * total;
  for (const m of valid) {
    r -= m.weight ?? 1;
    if (r <= 0) return m;
  }
  return valid[valid.length - 1];
}
