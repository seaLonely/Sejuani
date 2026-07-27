import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Brain, Trash2, Plus, Cpu, Check } from 'lucide-react';

type MemoryEntry = { id: string; category: 'preference' | 'project' | 'lesson'; content: string; weight: number; updatedAt: string };
type ProfileItem = { name: string; active: boolean; baseURL: string; model: string; apiKey: string };
type ProfilesResp = { profiles: ProfileItem[]; roles: Record<string, string> };

const CAT_LABEL: Record<string, string> = { preference: '偏好', project: '项目', lesson: '教训' };
const CAT_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = { preference: 'default', project: 'secondary', lesson: 'outline' };

export default function Memory() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [newContent, setNewContent] = useState('');
  const [newCat, setNewCat] = useState<'preference' | 'project' | 'lesson'>('preference');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [mem, prof] = await Promise.all([
        api.get<MemoryEntry[]>('/api/memory'),
        api.get<ProfilesResp>('/api/ai/profiles'),
      ]);
      setEntries(mem);
      setProfiles(prof.profiles);
      setRoles(prof.roles ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addMemory = async () => {
    if (!newContent.trim()) return;
    try {
      await api.post('/api/memory', { content: newContent.trim(), category: newCat });
      setNewContent('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const forget = async (id: string) => {
    try {
      await api.post('/api/memory/forget', { id });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const switchProfile = async (name: string) => {
    try {
      await api.post('/api/ai/profiles/use', { name });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-5 py-3 border-b">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Brain className="w-5 h-5" /> 记忆与模型
        </h2>
        <Button variant="outline" size="sm" onClick={load}>刷新</Button>
      </div>

      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3">
          {error}
        </div>
      )}

      <ScrollArea className="flex-1 px-5 py-4">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* 模型 profile */}
          <section>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
              <Cpu className="w-4 h-4" /> 模型 Profile
            </h3>
            <div className="space-y-2">
              {profiles.length === 0 && <div className="text-muted-foreground text-sm">（无 profile）</div>}
              {profiles.map((p) => (
                <Card key={p.name} className={p.active ? 'border-primary/50' : ''}>
                  <CardContent className="p-3 flex items-center gap-3">
                    {p.active ? <Check className="w-4 h-4 text-primary" /> : <span className="w-4" />}
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground text-xs font-mono">{p.model} @ {p.baseURL}</span>
                    <span className="ml-auto text-muted-foreground text-xs">{p.apiKey || '(无 key)'}</span>
                    {!p.active && (
                      <Button variant="outline" size="sm" onClick={() => switchProfile(p.name)}>切换</Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
            {Object.keys(roles).length > 0 && (
              <div className="text-xs text-muted-foreground mt-2">
                角色绑定：{Object.entries(roles).map(([r, p]) => `${r}→${p}`).join('  ')}
              </div>
            )}
          </section>

          {/* 长期记忆 */}
          <section>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
              <Brain className="w-4 h-4" /> 长期记忆（{entries.length}）
            </h3>
            <div className="flex gap-2 mb-3">
              <select
                className="rounded-md border bg-background px-2 text-sm"
                value={newCat}
                onChange={(e) => setNewCat(e.target.value as 'preference' | 'project' | 'lesson')}
              >
                <option value="preference">偏好</option>
                <option value="project">项目</option>
                <option value="lesson">教训</option>
              </select>
              <input
                className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
                placeholder="添加一条记忆…"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addMemory(); }}
              />
              <Button size="sm" onClick={() => void addMemory()}><Plus className="w-4 h-4" /></Button>
            </div>
            <div className="space-y-2">
              {entries.length === 0 && <div className="text-muted-foreground text-sm">（暂无记忆）</div>}
              {entries.map((e) => (
                <Card key={e.id}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <Badge variant={CAT_VARIANT[e.category]}>{CAT_LABEL[e.category]}</Badge>
                    <span className="text-sm flex-1">{e.content}</span>
                    <span className="text-muted-foreground text-xs">w{e.weight}</span>
                    <Button variant="ghost" size="sm" onClick={() => forget(e.id)}>
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
