import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Badge } from '@/components/ui/badge';
import { Settings2, Cloud, Bot } from 'lucide-react';

interface AiCfg { baseURL: string; model: string; temperature: number; apiKey: string; hasKey: boolean }
interface YunxiaoCfg { endpoint: string; organizationId: string; personalAccessToken: string; hasToken: boolean; defaultProjectId: string; defaultSprintId: string; defaultAssigneeId: string }
interface CoderToolItem { name: string; command: string; args: string[]; active: boolean }
interface CoderCfg { activeTool: string; tools: CoderToolItem[] }

export default function Settings() {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [ai, setAi] = useState<AiCfg | null>(null);
  const [aiForm, setAiForm] = useState({ baseURL: '', model: '', temperature: '0', apiKey: '' });
  const [yx, setYx] = useState<YunxiaoCfg | null>(null);
  const [yxForm, setYxForm] = useState({ endpoint: '', organizationId: '', personalAccessToken: '', defaultProjectId: '', defaultSprintId: '', defaultAssigneeId: '' });
  const [coder, setCoder] = useState<CoderCfg | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<AiCfg>('/api/config/ai'),
      api.get<YunxiaoCfg>('/api/config/yunxiao'),
      api.get<CoderCfg>('/api/config/coder'),
    ]).then(([a, y, c]) => {
      setAi(a);
      setAiForm({ baseURL: a.baseURL, model: a.model, temperature: String(a.temperature), apiKey: '' });
      setYx(y);
      setYxForm({ endpoint: y.endpoint, organizationId: y.organizationId, personalAccessToken: '', defaultProjectId: y.defaultProjectId, defaultSprintId: y.defaultSprintId, defaultAssigneeId: y.defaultAssigneeId });
      setCoder(c);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const flash = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 2000); };

  const saveAi = async () => {
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (aiForm.baseURL) patch.baseURL = aiForm.baseURL;
      if (aiForm.model) patch.model = aiForm.model;
      const t = parseFloat(aiForm.temperature);
      if (!Number.isNaN(t)) patch.temperature = t;
      if (aiForm.apiKey) patch.apiKey = aiForm.apiKey;
      const res = await api.post<AiCfg>('/api/config/ai', patch);
      setAi(res); setAiForm((f) => ({ ...f, apiKey: '' }));
      flash('AI 配置已保存');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const saveYx = async () => {
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (yxForm.endpoint) patch.endpoint = yxForm.endpoint;
      if (yxForm.organizationId) patch.organizationId = yxForm.organizationId;
      if (yxForm.personalAccessToken) patch.personalAccessToken = yxForm.personalAccessToken;
      if (yxForm.defaultProjectId) patch.defaultProjectId = yxForm.defaultProjectId;
      if (yxForm.defaultSprintId) patch.defaultSprintId = yxForm.defaultSprintId;
      if (yxForm.defaultAssigneeId) patch.defaultAssigneeId = yxForm.defaultAssigneeId;
      const res = await api.post<YunxiaoCfg>('/api/config/yunxiao', patch);
      setYx(res); setYxForm((f) => ({ ...f, personalAccessToken: '' }));
      flash('云效配置已保存');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const saveCoder = async (tool: string) => {
    setError(null);
    try {
      const res = await api.post<CoderCfg>('/api/config/coder', { activeTool: tool });
      setCoder(res); flash(`编码工具切换为 ${tool}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (!ai && !error) return <div className="p-6"><div className="animate-pulse text-muted-foreground">加载中…</div></div>;

  return (
    <div className="p-5 space-y-4 max-w-3xl">
      <h2 className="text-xl font-semibold">设置</h2>

      {error && <div className="rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3">{error}</div>}
      {success && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm p-3">{success}</div>}

      {/* AI Config */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><Bot className="w-4 h-4" /> AI 配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">Base URL</Label>
            <Input value={aiForm.baseURL} onChange={(e) => setAiForm((f) => ({ ...f, baseURL: e.target.value }))} />
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">Model</Label>
            <Input value={aiForm.model} onChange={(e) => setAiForm((f) => ({ ...f, model: e.target.value }))} />
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">Temperature</Label>
            <Input type="number" step="0.1" min="0" max="2" value={aiForm.temperature} onChange={(e) => setAiForm((f) => ({ ...f, temperature: e.target.value }))} className="w-24" />
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">API Key</Label>
            <Input type="password" placeholder={ai?.apiKey || '未设置'} value={aiForm.apiKey} onChange={(e) => setAiForm((f) => ({ ...f, apiKey: e.target.value }))} />
          </div>
          <div className="flex justify-end pt-1">
            <Button onClick={() => void saveAi()}>保存</Button>
          </div>
        </CardContent>
      </Card>

      {/* Yunxiao Config */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><Cloud className="w-4 h-4" /> 云效配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">Endpoint</Label>
            <Input value={yxForm.endpoint} onChange={(e) => setYxForm((f) => ({ ...f, endpoint: e.target.value }))} />
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">组织 ID</Label>
            <Input value={yxForm.organizationId} onChange={(e) => setYxForm((f) => ({ ...f, organizationId: e.target.value }))} />
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">Token</Label>
            <Input type="password" placeholder={yx?.personalAccessToken || '未设置'} value={yxForm.personalAccessToken} onChange={(e) => setYxForm((f) => ({ ...f, personalAccessToken: e.target.value }))} />
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">默认项目</Label>
            <Input value={yxForm.defaultProjectId} onChange={(e) => setYxForm((f) => ({ ...f, defaultProjectId: e.target.value }))} placeholder="选填" />
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-3">
            <Label className="text-right text-muted-foreground">默认迭代</Label>
            <Input value={yxForm.defaultSprintId} onChange={(e) => setYxForm((f) => ({ ...f, defaultSprintId: e.target.value }))} placeholder="选填" />
          </div>
          <div className="flex justify-end pt-1">
            <Button onClick={() => void saveYx()}>保存</Button>
          </div>
        </CardContent>
      </Card>

      {/* Coder Config */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><Settings2 className="w-4 h-4" /> 编码工具</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup value={coder?.activeTool} onValueChange={(v) => void saveCoder(v)} className="flex gap-6">
            {coder?.tools.map((t) => (
              <div key={t.name} className="flex items-center gap-2">
                <RadioGroupItem value={t.name} id={`coder-${t.name}`} />
                <Label htmlFor={`coder-${t.name}`} className="cursor-pointer">{t.name}</Label>
              </div>
            ))}
          </RadioGroup>
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/30"><th className="p-2 text-left text-muted-foreground font-medium">工具</th><th className="p-2 text-left text-muted-foreground font-medium">命令</th><th className="p-2 text-left text-muted-foreground font-medium">状态</th></tr></thead>
              <tbody>
                {coder?.tools.map((t) => (
                  <tr key={t.name} className="border-b last:border-0">
                    <td className="p-2 font-mono text-xs">{t.name}</td>
                    <td className="p-2 font-mono text-xs text-muted-foreground">{t.command} {t.args.join(' ')}</td>
                    <td className="p-2">{t.active ? <Badge variant="success">当前</Badge> : <Badge variant="secondary">备选</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
