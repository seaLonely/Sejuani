import { useCallback, useEffect, useState } from 'react';
import { api, pick, pickText } from '../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Wand2, RefreshCw } from 'lucide-react';

type TasksResp = { configured?: boolean } | unknown[];
interface Transition { id: string; name: string }

function taskId(t: unknown): string { return pickText(t, ['id', 'workItemId', 'identifier', 'serialNumber']); }
function taskType(t: unknown): string { return pickText(t, ['type.name', 'type', 'workItemType.name']); }

export default function Board() {
  const [tasks, setTasks] = useState<unknown[] | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [transitionId, setTransitionId] = useState('');
  const [comment, setComment] = useState('');
  const [acting, setActing] = useState(false);

  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterKeyword, setFilterKeyword] = useState('');

  const [fixTarget, setFixTarget] = useState<{ id: string; title: string } | null>(null);
  const [fixCoder, setFixCoder] = useState('claude');
  const [fixLoading, setFixLoading] = useState(false);

  const load = useCallback(() => {
    setError(null);
    const params = new URLSearchParams();
    params.set('sprint', 'current');
    if (filterType) params.set('type', filterType);
    if (filterStatus) params.set('status', filterStatus);
    if (filterKeyword) params.set('keyword', filterKeyword);
    api.get<TasksResp>(`/api/yunxiao/tasks?${params.toString()}`)
      .then((res) => {
        if (!Array.isArray(res) && res && res.configured === false) { setNotConfigured(true); setTasks([]); }
        else { setNotConfigured(false); setTasks(Array.isArray(res) ? res : []); }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [filterType, filterStatus, filterKeyword]);

  useEffect(load, [load]);

  const openDetail = (id: string) => {
    setSelectedId(id); setDetail(null); setTransitions([]); setTransitionId(''); setComment('');
    api.get<Record<string, unknown>>(`/api/yunxiao/tasks/${encodeURIComponent(id)}`)
      .then((d) => {
        setDetail(d);
        const raw = (pick(d, ['transitions', 'availableTransitions', 'statuses']) ?? []) as unknown[];
        const list = (Array.isArray(raw) ? raw : []).map((t) => ({ id: pickText(t, ['id', 'statusId']), name: pickText(t, ['name', 'statusName', 'label']) || pickText(t, ['id', 'statusId']) })).filter((t) => t.id);
        setTransitions(list);
        if (list.length > 0) setTransitionId(list[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const doTransition = async () => {
    if (!selectedId || !transitionId || acting) return;
    setActing(true);
    try { await api.post(`/api/yunxiao/tasks/${encodeURIComponent(selectedId)}/transition`, { statusId: transitionId }); openDetail(selectedId); load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setActing(false); }
  };

  const doComment = async () => {
    const content = comment.trim();
    if (!selectedId || !content || acting) return;
    setActing(true);
    try { await api.post(`/api/yunxiao/tasks/${encodeURIComponent(selectedId)}/comment`, { content }); setComment(''); openDetail(selectedId); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setActing(false); }
  };

  const triggerFix = async () => {
    if (!fixTarget) return;
    setFixLoading(true); setError(null);
    try {
      await api.post<{ workflowId: string }>('/api/fix', { issueId: fixTarget.id, coder: fixCoder });
      setFixTarget(null); window.location.hash = '/workflows';
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setFixLoading(false); }
  };

  return (
    <div className="p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">任务看板</h2>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-3.5 h-3.5 mr-1.5" />刷新</Button>
      </div>

      {error && <div className="rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3 mb-3">{error}</div>}
      {notConfigured && <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm p-3 mb-3">尚未配置云效。请先执行 <code className="bg-amber-100 px-1 rounded">sjn yunxiao-config</code> 配置。</div>}

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="">全部类型</option><option value="Req">需求</option><option value="Bug">缺陷</option><option value="Task">任务</option>
        </select>
        <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">全部状态</option><option value="待处理">待处理</option><option value="开发中">开发中</option><option value="待测试">待测试</option><option value="已完成">已完成</option>
        </select>
        <Input placeholder="关键词搜索…" value={filterKeyword} onChange={(e) => setFilterKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} className="w-44" />
        <Button variant="secondary" size="sm" onClick={load}>筛选</Button>
      </div>

      {tasks === null && !error && !notConfigured && <div className="text-muted-foreground py-8 text-center">加载中…</div>}

      {/* Card grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 overflow-y-auto flex-1">
        {(tasks ?? []).map((t, i) => {
          const id = taskId(t) || String(i);
          const status = pickText(t, ['status.name', 'status', 'statusName']);
          const type = taskType(t);
          const isBug = type.toLowerCase().includes('bug') || type.includes('缺陷');
          return (
            <Card key={id} className="cursor-pointer hover:border-primary/50 hover:shadow-md transition-all hover:-translate-y-0.5" onClick={() => openDetail(id)}>
              <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
                <span className="font-mono text-xs text-muted-foreground">{pickText(t, ['identifier', 'serialNumber', 'code']) || id}</span>
                <div className="flex items-center gap-1.5">
                  {status && <Badge variant="secondary">{status}</Badge>}
                  {isBug && <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={(e) => { e.stopPropagation(); setFixTarget({ id, title: pickText(t, ['title', 'subject', 'name']) }); }}><Wand2 className="w-3 h-3 mr-1" />AI 修复</Button>}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="font-medium text-sm mb-2 leading-snug">{pickText(t, ['title', 'subject', 'name'])}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline" className="text-[10px]">{type}</Badge>
                  <span>负责人：{pickText(t, ['assignee.name', 'assignee', 'owner.name']) || '—'}</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {tasks && tasks.length === 0 && !notConfigured && !error && <div className="text-muted-foreground py-8 text-center">当前迭代没有工单</div>}

      {/* AI Fix Dialog */}
      <Dialog open={!!fixTarget} onOpenChange={() => setFixTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AI 修复确认</DialogTitle>
            <DialogDescription>即将对以下工单启动 AI 自动修复工作流</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="font-mono text-sm bg-muted/30 p-2 rounded">{fixTarget?.id} — {fixTarget?.title}</p>
            <div className="flex items-center gap-3">
              <Label>编码工具</Label>
              <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={fixCoder} onChange={(e) => setFixCoder(e.target.value)}>
                <option value="claude">claude</option><option value="kimi">kimi</option><option value="opencode">opencode</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFixTarget(null)}>取消</Button>
            <Button disabled={fixLoading} onClick={() => void triggerFix()}>启动修复</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail drawer (simplified as dialog for now) */}
      <Dialog open={!!selectedId && !fixTarget} onOpenChange={() => setSelectedId(null)}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail ? pickText(detail, ['title', 'subject', 'name']) : '加载中…'}</DialogTitle>
            {detail && <DialogDescription>
              状态：{pickText(detail, ['status.name', 'status', 'statusName']) || '—'} · 负责人：{pickText(detail, ['assignee.name', 'assignee']) || '—'}
            </DialogDescription>}
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              {pickText(detail, ['description', 'content']) && (
                <pre className="text-xs bg-muted/30 rounded-md p-3 whitespace-pre-wrap max-h-40 overflow-auto">{pickText(detail, ['description', 'content'])}</pre>
              )}
              <div className="space-y-2">
                <Label className="text-muted-foreground">状态流转</Label>
                {transitions.length === 0 ? <p className="text-sm text-muted-foreground">无可用流转</p> : (
                  <div className="flex items-center gap-2">
                    <select className="h-9 rounded-md border border-input bg-background px-3 text-sm flex-1" value={transitionId} onChange={(e) => setTransitionId(e.target.value)}>
                      {transitions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <Button size="sm" disabled={acting} onClick={() => void doTransition()}>流转</Button>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">评论</Label>
                <textarea className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none" placeholder="输入评论内容…" value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button size="sm" disabled={acting || !comment.trim()} onClick={() => void doComment()}>提交评论</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
