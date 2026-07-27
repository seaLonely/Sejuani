import { useCallback, useEffect, useRef, useState } from 'react';
import { api, pick, pickText, subscribe } from '../api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageSquare, Plus, Send, ChevronDown, ChevronRight, Wrench } from 'lucide-react';

type ToolMsg = {
  kind: 'tool';
  name: string;
  args?: unknown;
  result?: unknown;
};
type Msg = { kind: 'user' | 'assistant'; text: string } | ToolMsg;

type PendingConfirm = { id: string; prompt: string };

function ToolBubble({ msg }: { msg: ToolMsg }) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      className="cursor-pointer border-border/50 bg-muted/20 hover:bg-muted/30 transition-colors"
      onClick={() => setOpen((v) => !v)}
    >
      <CardContent className="p-3">
        <div className="flex items-center gap-2">
          <Wrench className="w-3.5 h-3.5 text-muted-foreground" />
          <Badge variant="secondary" className="text-xs">工具调用</Badge>
          <span className="font-mono text-sm">{msg.name}</span>
          <span className="ml-auto text-muted-foreground text-xs flex items-center gap-0.5">
            {open ? <><ChevronDown className="w-3 h-3" /> 收起</> : <><ChevronRight className="w-3 h-3" /> 展开</>}
          </span>
        </div>
        {open && (
          <div className="mt-3 space-y-2 text-sm">
            {msg.args !== undefined && (
              <div>
                <div className="text-muted-foreground text-xs font-medium mb-1">参数</div>
                <pre className="bg-background rounded-md p-2 text-xs overflow-x-auto border">{JSON.stringify(msg.args, null, 2)}</pre>
              </div>
            )}
            {msg.result !== undefined && (
              <div>
                <div className="text-muted-foreground text-xs font-medium mb-1">结果</div>
                <pre className="bg-background rounded-md p-2 text-xs overflow-x-auto border">{typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Chat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<PendingConfirm | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const newSession = useCallback(async () => {
    setError(null);
    try {
      const res = await api.post<Record<string, unknown>>('/api/agent/session');
      const id = pickText(res, ['sessionId', 'id']);
      if (!id) throw new Error('后端未返回 sessionId');
      setSessionId(id);
      setMessages([]);
      setConfirmReq(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!sessionId) void newSession();
  }, [sessionId, newSession]);

  useEffect(() => {
    if (!sessionId) return;
    return subscribe(
      `/api/agent/events?sessionId=${encodeURIComponent(sessionId)}`,
      (data, event) => {
        const type = pickText(data, ['type', 'kind']) || event;
        if (type === 'tool') {
          setMessages((prev) => [
            ...prev,
            {
              kind: 'tool',
              name: pickText(data, ['name', 'tool']) || 'unknown',
              args: pick(data, ['args', 'input', 'params']),
              result: pick(data, ['result', 'output']),
            },
          ]);
        } else if (type === 'confirm') {
          setConfirmReq({
            id: pickText(data, ['id', 'confirmId']),
            prompt: pickText(data, ['message', 'prompt', 'command', 'detail']) || '后端请求确认一个操作',
          });
        }
      },
    );
  }, [sessionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, sending]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setMessages((prev) => [...prev, { kind: 'user', text }]);
    setSending(true);
    setError(null);
    try {
      let sid = sessionId;
      if (!sid) {
        const res = await api.post<Record<string, unknown>>('/api/agent/session');
        sid = pickText(res, ['sessionId', 'id']);
        setSessionId(sid);
      }
      const res = await api.post<Record<string, unknown>>('/api/agent/chat', {
        sessionId: sid,
        input: text,
      });
      const reply = pickText(res, ['reply', 'text', 'output', 'message']) || JSON.stringify(res);
      setMessages((prev) => [...prev, { kind: 'assistant', text: reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const resolveConfirm = async (ok: boolean) => {
    if (!confirmReq || !sessionId) return;
    const { id } = confirmReq;
    setConfirmReq(null);
    try {
      await api.post('/api/agent/confirm', { sessionId, id, ok });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <MessageSquare className="w-5 h-5" /> Agent 对话
        </h2>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">
            {sessionId ? `会话 ${sessionId.slice(0, 8)}…` : '未建立会话'}
          </span>
          <Button variant="outline" size="sm" onClick={newSession}>
            <Plus className="w-3.5 h-3.5 mr-1" /> 新建会话
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3">
          {error}
        </div>
      )}

      {/* Messages */}
      <ScrollArea className="flex-1 px-5 py-4" ref={listRef}>
        <div className="space-y-3 max-w-3xl mx-auto">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground py-12">
              开始对话吧，Agent 可以帮你操作依赖、云效与工作流。
            </div>
          )}
          {messages.map((m, i) =>
            m.kind === 'tool' ? (
              <ToolBubble key={i} msg={m} />
            ) : m.kind === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="bubble-user-gradient text-white rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="bg-card border rounded-2xl rounded-bl-sm px-4 py-2.5 max-w-[75%] text-sm leading-relaxed whitespace-pre-wrap">
                  {m.text}
                </div>
              </div>
            ),
          )}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-card border rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-muted-foreground animate-pulse">
                思考中…
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input Area */}
      <div className="border-t px-5 py-3">
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-[40px] max-h-[120px]"
            value={input}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button disabled={sending || !input.trim()} onClick={() => void send()} size="sm">
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Confirm Dialog */}
      <Dialog open={!!confirmReq} onOpenChange={(open) => { if (!open) void resolveConfirm(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>操作确认</DialogTitle>
            <DialogDescription>{confirmReq?.prompt}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => void resolveConfirm(false)}>取消</Button>
            <Button onClick={() => void resolveConfirm(true)}>确认执行</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
