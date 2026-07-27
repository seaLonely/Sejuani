import { Router, sendJson, sendError } from '../http';
import { SejuaniConfig } from '../../core/config';
import { listMemory, upsertMemory, forgetMemory, MemoryCategory } from '../../core/agent/memory';
import { listProfiles, useProfile, upsertProfile, setRole, getRoles, maskApiKey, AiRole } from '../../core/state/aiConfig';

/**
 * 记忆与模型 profile 路由（R5 桌面端对接）：
 * - GET  /api/memory                记忆列表（当前域）
 * - POST /api/memory                写入/更新 { content, category?, id? }
 * - POST /api/memory/forget         删除 { id }
 * - GET  /api/ai/profiles           profile 列表（key 脱敏）+ 角色绑定
 * - POST /api/ai/profiles           新增/覆写 { name, baseURL, apiKey, model }
 * - POST /api/ai/profiles/use       切换激活 { name }
 * - POST /api/ai/roles              绑定角色 { role, profile|null }
 */
const CATEGORIES: MemoryCategory[] = ['preference', 'project', 'lesson'];
const AI_ROLES: AiRole[] = ['chat', 'planner', 'compress', 'agentTask'];

export function registerMemoryRoutes(router: Router, config: SejuaniConfig): void {
  const domain = config.activeDomain;

  router.get('/api/memory', (r) => {
    sendJson(r.res, 200, listMemory(domain));
  });

  router.post('/api/memory', (r) => {
    const { content, category, id } = r.body ?? {};
    if (typeof content !== 'string' || !content.trim()) {
      sendError(r.res, 400, 'content 不能为空');
      return;
    }
    const cat = CATEGORIES.includes(category) ? (category as MemoryCategory) : undefined;
    const entry = upsertMemory(domain, { content: content.trim(), category: cat, id: id ? String(id) : undefined });
    sendJson(r.res, 200, entry);
  });

  router.post('/api/memory/forget', (r) => {
    const { id } = r.body ?? {};
    if (!id) {
      sendError(r.res, 400, '缺少 id');
      return;
    }
    sendJson(r.res, 200, { ok: forgetMemory(domain, String(id)) });
  });

  router.get('/api/ai/profiles', (r) => {
    const roles = getRoles();
    sendJson(r.res, 200, {
      profiles: listProfiles().map((p) => ({
        name: p.name,
        active: p.active,
        baseURL: p.profile.baseURL,
        model: p.profile.model,
        apiKey: p.profile.apiKey ? maskApiKey(p.profile.apiKey) : '',
      })),
      roles,
    });
  });

  router.post('/api/ai/profiles', (r) => {
    const { name, baseURL, apiKey, model } = r.body ?? {};
    if (!name) {
      sendError(r.res, 400, '缺少 name');
      return;
    }
    try {
      upsertProfile(String(name), { baseURL: String(baseURL ?? ''), apiKey: String(apiKey ?? ''), model: String(model ?? '') });
      sendJson(r.res, 200, { ok: true });
    } catch (err) {
      sendError(r.res, 400, (err as Error).message);
    }
  });

  router.post('/api/ai/profiles/use', (r) => {
    const { name } = r.body ?? {};
    try {
      useProfile(String(name));
      sendJson(r.res, 200, { ok: true });
    } catch (err) {
      sendError(r.res, 400, (err as Error).message);
    }
  });

  router.post('/api/ai/roles', (r) => {
    const { role, profile } = r.body ?? {};
    if (!AI_ROLES.includes(role)) {
      sendError(r.res, 400, `未知角色: ${role}`);
      return;
    }
    try {
      setRole(role as AiRole, profile ? String(profile) : null);
      sendJson(r.res, 200, { ok: true });
    } catch (err) {
      sendError(r.res, 400, (err as Error).message);
    }
  });
}
