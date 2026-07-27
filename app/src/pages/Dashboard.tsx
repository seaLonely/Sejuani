import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart3, Search } from 'lucide-react';

type CatalogEntry = { name: string; version: string; dir: string };
type UsageEntry = {
  name: string;
  count: number;
  projects: string[];
  ranges: string[];
  catalogVersion?: string;
};
type UsageResp = { used?: UsageEntry[]; unused?: string[] };
type TreeResp = { layers?: string[][]; edges?: unknown };

function LoadingSkeleton() {
  return (
    <div className="space-y-2 p-4">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function CatalogTable() {
  const [data, setData] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<CatalogEntry[]>('/api/catalog')
      .then((d) => setData(Array.isArray(d) ? d : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <div className="rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3">{error}</div>;
  if (!data) return <LoadingSkeleton />;
  return (
    <div className="rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/30">
            <th className="p-2.5 text-left text-muted-foreground font-medium">名称</th>
            <th className="p-2.5 text-left text-muted-foreground font-medium">版本</th>
            <th className="p-2.5 text-left text-muted-foreground font-medium">目录</th>
          </tr>
        </thead>
        <tbody>
          {data.map((c) => (
            <tr key={c.name} className="border-b last:border-0 hover:bg-muted/10 transition-colors">
              <td className="p-2.5 font-mono text-xs">{c.name}</td>
              <td className="p-2.5 font-mono text-xs"><Badge variant="outline">{c.version}</Badge></td>
              <td className="p-2.5 font-mono text-xs text-muted-foreground">{c.dir}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageTable() {
  const [data, setData] = useState<UsageResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  useEffect(() => {
    api
      .get<UsageResp>('/api/usage')
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const rows = useMemo(() => {
    const used = data?.used ?? [];
    const kw = keyword.trim().toLowerCase();
    return kw ? used.filter((u) => u.name.toLowerCase().includes(kw)) : used;
  }, [data, keyword]);

  if (error) return <div className="rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3">{error}</div>;
  if (!data) return <LoadingSkeleton />;

  const isOutdated = (u: UsageEntry) =>
    !!u.catalogVersion && !(u.ranges ?? []).includes(u.catalogVersion);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="搜索组件名…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {rows.length} 个已使用{data.unused ? `，${data.unused.length} 个未使用` : ''}
        </span>
      </div>
      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="p-2.5 text-left text-muted-foreground font-medium">组件</th>
              <th className="p-2.5 text-left text-muted-foreground font-medium">使用数</th>
              <th className="p-2.5 text-left text-muted-foreground font-medium">工程</th>
              <th className="p-2.5 text-left text-muted-foreground font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.name} className="border-b last:border-0 hover:bg-muted/10 transition-colors">
                <td className="p-2.5 font-mono text-xs">{u.name}</td>
                <td className="p-2.5">{u.count}</td>
                <td className="p-2.5 font-mono text-xs text-muted-foreground">{(u.projects ?? []).join('、')}</td>
                <td className="p-2.5">
                  {isOutdated(u)
                    ? <Badge variant="warning">过期</Badge>
                    : <Badge variant="success">最新</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DepsTreeView() {
  const [data, setData] = useState<TreeResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<TreeResp>('/api/deps-tree')
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <div className="rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm p-3">{error}</div>;
  if (!data) return <LoadingSkeleton />;
  const layers = data.layers ?? [];
  if (layers.length === 0) return <div className="text-center text-muted-foreground py-8">暂无依赖分层数据</div>;
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {layers.map((names, i) => (
        <div key={i} className="min-w-[140px] flex-shrink-0">
          <div className="text-xs font-medium text-muted-foreground mb-2 px-1">Layer {i}</div>
          <div className="space-y-1">
            {names.map((n) => (
              <div key={n} className="rounded-md border bg-card px-3 py-1.5 font-mono text-xs hover:bg-muted/20 transition-colors">
                {n}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  return (
    <div className="p-5 space-y-4">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        <BarChart3 className="w-5 h-5" /> 依赖看板
      </h2>

      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="tree">DepsTree</TabsTrigger>
        </TabsList>

        <TabsContent value="catalog">
          <CatalogTable />
        </TabsContent>
        <TabsContent value="usage">
          <UsageTable />
        </TabsContent>
        <TabsContent value="tree">
          <DepsTreeView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
