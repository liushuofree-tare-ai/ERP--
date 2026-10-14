// AI 分析的接口配置（SPEC 第四节第 11 项）：只存浏览器里一个独立的
// localStorage 键 qipei_v2_ai，绝不进业务存档（qipei_v2_db_v1），
// 因此也绝不进任何备份——备份文件里没有钥匙，恢复后需要重填。
// 这是刻意的：钥匙是用户自己的凭据，不跟着业务数据到处跑。

export const AI_CFG_KEY = 'qipei_v2_ai';

export const DEFAULT_AI_CFG = {
  baseUrl: 'https://api.ant-ling.com/v1',
  apiKey: '',
  model: 'Ling-3.1-flash',
};

/** 读配置（没存过/损坏时给默认值）；返回 { baseUrl, apiKey, model } */
export function loadAiConfig() {
  try {
    const raw = localStorage.getItem(AI_CFG_KEY);
    if (!raw) return { ...DEFAULT_AI_CFG };
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return { ...DEFAULT_AI_CFG };
    return {
      baseUrl: typeof obj.baseUrl === 'string' && obj.baseUrl.trim() ? obj.baseUrl : DEFAULT_AI_CFG.baseUrl,
      apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : '',
      model: typeof obj.model === 'string' && obj.model.trim() ? obj.model : DEFAULT_AI_CFG.model,
    };
  } catch (e) {
    return { ...DEFAULT_AI_CFG };
  }
}

/** 存配置：只写 qipei_v2_ai 这一个键，不碰业务存档 */
export function saveAiConfig(cfg) {
  const clean = {
    baseUrl: String((cfg && cfg.baseUrl) || '').trim() || DEFAULT_AI_CFG.baseUrl,
    apiKey: String((cfg && cfg.apiKey) || ''),
    model: String((cfg && cfg.model) || '').trim() || DEFAULT_AI_CFG.model,
  };
  try { localStorage.setItem(AI_CFG_KEY, JSON.stringify(clean)); } catch (e) { /* 存不下不挡用 */ }
  return clean;
}
