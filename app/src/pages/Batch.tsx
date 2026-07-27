import { useState } from 'react';
import { api } from '../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowRight } from 'lucide-react';

interface VersionChange { name: string; before: string; after: string }
interface UpgradeChange { project: string; deps: string; hits: number }
interface UrlChange { name: string; hits: number }

export default function Batch() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const [bump, setBump] = useState<'patch' | 'minor' | 'major'>('patch');
  const [customVer, setCustomVer] = useState('');
  const [verChanges, setVerChanges] = useState<VersionChange[] | null>(null);

  const [onlyFilter, setOnlyFilter] = useState('');
  const [upgradeChanges, setUpgradeChanges] = useState<UpgradeChange[] | null>(null);

  const [urlFrom, setUrlFrom] = useState('');
  const [urlTo, setUrlTo] = useState('');
  const [urlChanges, setUrlChanges] = useState<UrlChange[] | null>(null);

  const flash = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 2500); };

  const previewVersion = async () => {
    setError(null); setLoading(true); setVerChanges(null);
    try {
      const body = customVer.trim() ? { to: customVer.trim(), dryRun: true } : { bump, dryRun: true };
      const res = await api.post<{ changes: VersionChange[] }>('/api/batch/set-version', body);
      setVerChanges(res.changes);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  const applyVersion = async () => {
    setError(null); setLoading(true);
    try {
      const body = customVer.trim() ? { to: customVer.trim(), dryRun: false } : { bump, dryRun: false };
      await api.post('/api/batch/set-version', body);
      flash('版本修改已应用'); setVerChanges(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const previewUpgrade = async () => {
    setError(null); setLoading(true); setUpgradeChanges(null);
    try {
      const body: Record<string, unknown> = { dryRun: true };
      if (onlyFilter.trim()) body.only = onlyFilter.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await api.post<{ changes: UpgradeChange[] }>('/api/batch/upgrade', body);
      setUpgradeChanges(res.changes);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  const applyUpgrade = async () => {
    setError(null); setLoading(true);
    try {
      const body: Record<string, unknown> = { dryRun: false };
      if (onlyFilter.trim()) body.only = onlyFilter.split(',').map((s) => s.trim()).filter(Boolean);
      await api.post('/api/batch/upgrade', body);
      flash('依赖升级已应用'); setUpgradeChanges(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const previewUrl = async () => {
    setError(null); setLoading(true); setUrlChanges(null);
    try {
      const res = await api.post<{ changes: UrlChange[] }>('/api/batch/replace-url', { from: urlFrom, to: urlTo, dryRun: true });
      setUrlChanges(res.changes);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  const applyUrl = async () => {
    setError(null); setLoading(true);
    try {
      await api.post('/api/batch/replace-url', { from: urlFrom, to: urlTo, dryRun: false });
      flash('URL 替换已应用'); setUrlChanges(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="p-5 space-y-4">
      <h2 className="text-xl font-semibold">批量操作</h2>
      {error && <div className="rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3">{error}</div>}
      {success && <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm p-3">{success}</div>}

      <Tabs defaultValue="version">
        <TabsList>
          <TabsTrigger value="version">版本管理</TabsTrigger>
          <TabsTrigger value="upgrade">依赖升级</TabsTrigger>
          <TabsTrigger value="url">URL 替换</TabsTrigger>
        </TabsList>

        <TabsContent value="version" className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {(['patch', 'minor', 'major'] as const).map((b) => (
              <Button key={b} variant={bump === b && !customVer ? 'default' : 'outline'} size="sm" onClick={() => { setBump(b); setCustomVer(''); }}>
                {b.charAt(0).toUpperCase() + b.slice(1)}
              </Button>
            ))}
            <span className="text-muted-foreground text-sm">或</span>
            <Input placeholder="自定义版本 (如 2.0.0)" value={customVer} onChange={(e) => setCustomVer(e.target.value)} className="w-44" />
            <Button disabled={loading} onClick={() => void previewVersion()}>预览</Button>
          </div>
          {verChanges && (
            <Card>
              <CardContent className="p-3 space-y-1">
                {verChanges.length === 0 && <p className="text-muted-foreground text-sm py-2">无需变更</p>}
                {verChanges.map((c) => (
                  <div key={c.name} className="flex items-center justify-between py-1.5 border-b last:border-0">
                    <span className="font-mono text-sm">{c.name}</span>
                    <span className="flex items-center gap-1.5 text-sm">
                      <Badge variant="secondary">{c.before}</Badge>
                      <ArrowRight className="w-3 h-3 text-muted-foreground" />
                      <Badge variant="success">{c.after}</Badge>
                    </span>
                  </div>
                ))}
                {verChanges.length > 0 && <div className="flex justify-end pt-2"><Button disabled={loading} onClick={() => void applyVersion()}>确认执行</Button></div>}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="upgrade" className="space-y-3">
          <div className="flex items-center gap-2">
            <Input placeholder="仅升级指定组件 (逗号分隔，留空=全部)" value={onlyFilter} onChange={(e) => setOnlyFilter(e.target.value)} className="max-w-sm" />
            <Button disabled={loading} onClick={() => void previewUpgrade()}>预览</Button>
          </div>
          {upgradeChanges && (
            <Card>
              <CardContent className="p-3 space-y-1">
                {upgradeChanges.length === 0 && <p className="text-muted-foreground text-sm py-2">所有依赖已是最新</p>}
                {upgradeChanges.map((c) => (
                  <div key={c.project} className="flex items-center justify-between py-1.5 border-b last:border-0">
                    <span className="font-mono text-sm">{c.project}</span>
                    <span className="text-muted-foreground text-xs">{c.deps || `${c.hits} 处`}</span>
                  </div>
                ))}
                {upgradeChanges.length > 0 && <div className="flex justify-end pt-2"><Button disabled={loading} onClick={() => void applyUpgrade()}>确认执行</Button></div>}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="url" className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Input placeholder="From URL" value={urlFrom} onChange={(e) => setUrlFrom(e.target.value)} className="w-56" />
            <Input placeholder="To URL" value={urlTo} onChange={(e) => setUrlTo(e.target.value)} className="w-56" />
            <Button disabled={loading || !urlFrom || !urlTo} onClick={() => void previewUrl()}>预览</Button>
          </div>
          {urlChanges && (
            <Card>
              <CardContent className="p-3 space-y-1">
                {urlChanges.length === 0 && <p className="text-muted-foreground text-sm py-2">未找到匹配</p>}
                {urlChanges.map((c) => (
                  <div key={c.name} className="flex items-center justify-between py-1.5 border-b last:border-0">
                    <span className="font-mono text-sm">{c.name}</span>
                    <Badge variant="warning">{c.hits} 处命中</Badge>
                  </div>
                ))}
                {urlChanges.length > 0 && <div className="flex justify-end pt-2"><Button disabled={loading} onClick={() => void applyUrl()}>确认执行</Button></div>}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
