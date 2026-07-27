import { Router, sendJson, sendError } from '../http';
import { getAiConfig, setAiConfig, maskApiKey } from '../../core/state/aiConfig';
import { getYunxiaoConfig, setYunxiaoConfig, maskToken } from '../../core/state/yunxiaoConfig';
import { getCoderConfig, setActiveCoder, isCoderTool, CODER_TOOLS, CoderTool } from '../../core/state/coderConfig';

/**
 * 配置管理路由：
 * - GET  /api/config/ai       AI 配置（apiKey 打码）
 * - POST /api/config/ai       更新 AI 配置
 * - GET  /api/config/yunxiao  云效配置（token 打码）
 * - POST /api/config/yunxiao  更新云效配置
 * - GET  /api/config/coder    编码工具配置
 * - POST /api/config/coder    更新编码工具配置
 */

export function registerConfigRoutes(router: Router): void {
  // ===== AI 配置 =====
  router.get('/api/config/ai', (r) => {
    const cfg = getAiConfig();
    sendJson(r.res, 200, {
      baseURL: cfg.baseURL,
      model: cfg.model,
      temperature: cfg.temperature,
      apiKey: maskApiKey(cfg.apiKey),
      hasKey: cfg.apiKey.length > 0,
    });
  });

  router.post('/api/config/ai', (r) => {
    const { baseURL, apiKey, model, temperature } = r.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof baseURL === 'string') patch.baseURL = baseURL.trim();
    if (typeof apiKey === 'string') patch.apiKey = apiKey.trim();
    if (typeof model === 'string') patch.model = model.trim();
    if (typeof temperature === 'number') patch.temperature = temperature;
    const cfg = setAiConfig(patch as any);
    sendJson(r.res, 200, {
      baseURL: cfg.baseURL,
      model: cfg.model,
      temperature: cfg.temperature,
      apiKey: maskApiKey(cfg.apiKey),
      hasKey: cfg.apiKey.length > 0,
    });
  });

  // ===== 云效配置 =====
  router.get('/api/config/yunxiao', (r) => {
    const cfg = getYunxiaoConfig();
    sendJson(r.res, 200, {
      endpoint: cfg.endpoint,
      organizationId: cfg.organizationId,
      personalAccessToken: maskToken(cfg.personalAccessToken),
      hasToken: cfg.personalAccessToken.length > 0,
      defaultProjectId: cfg.defaultProjectId ?? '',
      defaultSprintId: cfg.defaultSprintId ?? '',
      defaultAssigneeId: cfg.defaultAssigneeId ?? '',
    });
  });

  router.post('/api/config/yunxiao', (r) => {
    const { endpoint, organizationId, personalAccessToken, defaultProjectId, defaultSprintId, defaultAssigneeId } =
      r.body ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof endpoint === 'string') patch.endpoint = endpoint.trim() || undefined;
    if (typeof organizationId === 'string') patch.organizationId = organizationId.trim() || undefined;
    if (typeof personalAccessToken === 'string') patch.personalAccessToken = personalAccessToken.trim() || undefined;
    if (typeof defaultProjectId === 'string') patch.defaultProjectId = defaultProjectId.trim() || undefined;
    if (typeof defaultSprintId === 'string') patch.defaultSprintId = defaultSprintId.trim() || undefined;
    if (typeof defaultAssigneeId === 'string') patch.defaultAssigneeId = defaultAssigneeId.trim() || undefined;
    const cfg = setYunxiaoConfig(patch as any);
    sendJson(r.res, 200, {
      endpoint: cfg.endpoint,
      organizationId: cfg.organizationId,
      personalAccessToken: maskToken(cfg.personalAccessToken),
      hasToken: cfg.personalAccessToken.length > 0,
      defaultProjectId: cfg.defaultProjectId ?? '',
      defaultSprintId: cfg.defaultSprintId ?? '',
      defaultAssigneeId: cfg.defaultAssigneeId ?? '',
    });
  });

  // ===== 编码工具配置 =====
  router.get('/api/config/coder', (r) => {
    const cfg = getCoderConfig();
    sendJson(r.res, 200, {
      activeTool: cfg.activeTool,
      tools: CODER_TOOLS.map((t) => ({
        name: t,
        command: cfg.tools[t].command,
        args: cfg.tools[t].args,
        active: t === cfg.activeTool,
      })),
    });
  });

  router.post('/api/config/coder', (r) => {
    const { activeTool } = r.body ?? {};
    if (typeof activeTool !== 'string' || !isCoderTool(activeTool)) {
      sendError(r.res, 400, `activeTool 必须是 ${CODER_TOOLS.join('/')} 之一`);
      return;
    }
    const cfg = setActiveCoder(activeTool as CoderTool);
    sendJson(r.res, 200, {
      activeTool: cfg.activeTool,
      tools: CODER_TOOLS.map((t) => ({
        name: t,
        command: cfg.tools[t].command,
        args: cfg.tools[t].args,
        active: t === cfg.activeTool,
      })),
    });
  });
}
