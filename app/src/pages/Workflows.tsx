import { useCallback, useEffect, useRef, useState } from 'react';
import { api, pick, pickText, subscribe } from '../api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Workflow, Play, RotateCcw, RefreshCw, CheckCircle2, XCircle, Clock, SkipForward } from 'lucide-react';

type WfItem = { id: string; name: string };
type StepState = 'pending' | 'ok' | 'failed' | 'skipped';
type Step = { id: string; name: string; state: StepState };

const STATE_ICON: Record<StepState, React.ReactNode> = {
  pending: <Clock className="w-3.5 h-3.5 text-muted-foreground" />,
  ok: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />,
  failed: <XCircle className="w-3.5 h-3.5 text-destructive" />,
  skipped: <SkipForward className="w-3.5 h-3.5 text-muted-foreground" />,
};

const STATE_VARIANT: Record<StepState, 'secondary' | 'success' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  ok: 'success',
  failed: 'destructive',
  skipped: 'outline',
};

function normalizeSteps(detail: Record<string, unknown>): Step[] {
  const spec = (pick(detail, ['spec']) ?? {}) as Record<string, unknown>;
  const state = (pick(detail, ['state']) ?? {}) as Record<string, unknown>;
  const specSteps = (pick(spec, ['steps']) ?? []) as unknown[];
  const stateSteps = pick(state, ['steps', 'stepStates']);
  const list = Array.isArray(specSteps) ? specSteps : [];
  return list.map((s, i) => {
    const id = pickText(s, ['id', 'name']) || `step-${i}`;
    const name = pickText(s, ['name', 'id', 'description']) || id;
    let st: unknown;
    if (stateSteps && typeof stateSteps === 'object' && !Array.isArray(stateSteps)) {
      st = (stateSteps as Record<string, unknown>)[id];
    } else if (Array.isArray(stateSteps)) {
      const hit = stateSteps.find((x) => pickText(x, ['id', 'name']) === id);
      st = pick(hit, ['status', 'state']) ?? hit;
    }
    const stText = typeof st === 'object' && st !== null ? pickText(st, ['status', 'state']) : String(st ?? '');
    const state2: StepState =
      stText === 'ok' || stText === 'failed' || stText === 'skipped' ? stText : 'pending';
    return { id, name, state: state2 };
  });
}

export default function Workflows() {
  const [list, setList] = useState<WfItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [acting, setActing] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(() => {
    api
      .get<unknown[]>('/api/workflows')
      .then((res) => {
        const arr = Array.isArray(res) ? res : [];
        setList(
          arr.map((w) => ({
            id: pickText(w, ['id', 'name', 'file']),
            name: pickText(w, ['name', 'title', 'id']),
          })),
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(loadList, [loadList]);

  const loadDetail = useCallback((id: string) => {
    setDetail(null);
    api
      .get<Record<string, unknown>>(`/api/workflows/${encodeURIComponent(id)}`)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const select = (id: string) => {
    setSelected(id);
    setLogs([]);
    loadDetail(id);
  };

  useEffect(() => {
    if (!selected) return;
    return subscribe(`/api/workflows/${encodeURIComponent(selected)}/logs`, (data) => {
      const line =
        typeof data === 'string' ? data : pickText(data, ['line', 'text', 'message']) || JSON.stringify(data);
      setLogs((prev) => [...prev, line]);
    });
  }, [selected]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const action = async (kind: 'run' | 'resume') => {
    if (!selected || acting) return;
    setActing(true);
    setError(null);
    try {
      await api.post(`/api/workflows/${encodeURIComponent(selected)}/${kind}`);
      loadDetail(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  const steps = detail ? normalizeSteps(detail) : [];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Workflow className="w-5 h-5" /> 工作流
        </h2>
        <Button variant="outline" size="sm" onClick={loadList}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> 刷新
        </Button>
      </div>

      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3">
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar list */}
        <ScrollArea className="w-56 border-r">
          <div className="p-2 space-y-0.5">
            {list === null && !error && (
              <div className="p-3 space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            )}
            {(list ?? []).map((w) => (
              <button
                key={w.id}
                className={`w-full text-left rounded-md px-3 py-2 text-sm transition-colors ${
                  selected === w.id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted/50 text-foreground'
                }`}
                onClick={() => select(w.id)}
              >
                {w.name}
              </button>
            ))}
            {list && list.length === 0 && (
              <div className="text-center text-muted-foreground text-xs py-6">暂无工作流</div>
            )}
          </div>
        </ScrollArea>

        {/* Detail */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              从左侧选择一个工作流
            </div>
          ) : (
            <>
              {/* Actions */}
              <div className="flex items-center gap-2 px-5 py-3 border-b">
                <span className="font-mono text-xs text-muted-foreground mr-auto">{selected}</span>
                <Button size="sm" disabled={acting} onClick={() => void action('run')}>
                  <Play className="w-3.5 h-3.5 mr-1" /> 运行
                </Button>
                <Button variant="outline" size="sm" disabled={acting} onClick={() => void action('resume')}>
                  <RotateCcw className="w-3.5 h-3.5 mr-1" /> 续跑
                </Button>
                <Button variant="ghost" size="sm" disabled={acting} onClick={() => loadDetail(selected)}>
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
              </div>

              {/* Steps */}
              <div className="px-5 py-3 space-y-2 border-b">
                {!detail ? (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                ) : steps.length === 0 ? (
                  <div className="text-muted-foreground text-sm">该工作流没有步骤定义</div>
                ) : (
                  steps.map((s) => (
                    <div key={s.id} className="flex items-center gap-2">
                      {STATE_ICON[s.state]}
                      <span className="font-mono text-sm">{s.name}</span>
                      <Badge variant={STATE_VARIANT[s.state]} className="ml-auto text-xs">
                        {s.state}
                      </Badge>
                    </div>
                  ))
                )}
              </div>

              {/* Logs */}
              <div className="flex-1 overflow-hidden flex flex-col">
                <div className="px-5 py-2 text-xs font-medium text-muted-foreground">日志输出</div>
                <div
                  ref={logRef}
                  className="flex-1 overflow-y-auto log-panel-dark rounded-md mx-5 mb-3 p-3 font-mono text-xs leading-relaxed"
                >
                  {logs.length === 0 ? (
                    <span className="text-muted-foreground/70">暂无日志</span>
                  ) : (
                    logs.map((l, i) => (
                      <div key={i} className="whitespace-pre-wrap">{l}</div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
