import { createContext, useContext, useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api/client';
import { Separator } from '@/components/ui/separator';
import { MessageSquare, LayoutGrid, Workflow, Layers, BarChart3, Settings as SettingsIcon, Brain } from 'lucide-react';
import Chat from './pages/Chat';
import Dashboard from './pages/Dashboard';
import Board from './pages/Board';
import Workflows from './pages/Workflows';
import Batch from './pages/Batch';
import Settings from './pages/Settings';
import Memory from './pages/Memory';
import logoSvg from './assets/logo.svg';

const BackendContext = createContext(false);
export const useBackend = () => useContext(BackendContext);

const NAV_SMART = [
  { to: '/chat', label: 'Agent 对话', icon: MessageSquare },
  { to: '/board', label: '任务看板', icon: LayoutGrid },
  { to: '/workflows', label: '工作流', icon: Workflow },
  { to: '/memory', label: '记忆与模型', icon: Brain },
];

const NAV_MANAGE = [
  { to: '/batch', label: '批量操作', icon: Layers },
  { to: '/dashboard', label: '依赖看板', icon: BarChart3 },
  { to: '/settings', label: '设置', icon: SettingsIcon },
];

export default function App() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        await api.get('/api/health');
        if (alive) setConnected(true);
      } catch {
        if (alive) setConnected(false);
      }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  return (
    <BackendContext.Provider value={connected}>
      <HashRouter>
        <div className="flex h-screen">
          {/* Sidebar */}
          <aside className="sidebar-gradient w-[210px] flex-shrink-0 flex flex-col p-3 text-sidebar-foreground">
            <div className="flex items-center gap-2.5 px-2.5 pb-4 text-white font-bold text-lg">
              <img src={logoSvg} alt="logo" className="w-7 h-7" />
              Sejuani
            </div>

            <nav className="flex-1 space-y-0.5">
              <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                智能
              </div>
              {NAV_SMART.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-white/15 text-white font-medium shadow-[inset_3px_0_0_hsl(210_70%_65%)]'
                        : 'text-sidebar-foreground hover:bg-white/8'
                    }`
                  }
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </NavLink>
              ))}

              <Separator className="!my-3 bg-white/10" />

              <div className="px-2.5 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-white/40">
                管理
              </div>
              {NAV_MANAGE.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-white/15 text-white font-medium shadow-[inset_3px_0_0_hsl(210_70%_65%)]'
                        : 'text-sidebar-foreground hover:bg-white/8'
                    }`
                  }
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className="mt-auto px-2.5 py-2 text-xs text-white/60 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]' : 'bg-red-400'}`} />
              {connected ? '后端已连接' : '后端未连接'}
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 overflow-auto bg-background">
            <Routes>
              <Route path="/" element={<Chat />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/board" element={<Board />} />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/memory" element={<Memory />} />
              <Route path="/batch" element={<Batch />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </BackendContext.Provider>
  );
}
