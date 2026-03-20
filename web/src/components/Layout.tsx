import type { ReactNode } from 'react'
import type { Page } from '../App'

const NAV_ITEMS: { key: Page; label: string; icon: string; separator?: boolean }[] = [
  { key: 'chat', label: '对话', icon: '💬' },
  { key: 'dashboard', label: '控制面板', icon: '◈', separator: true },
  { key: 'agents', label: 'Agent', icon: '◉' },
  { key: 'graphs', label: 'Graph 编排', icon: '◇' },
  { key: 'models', label: '模型库', icon: '⬡', separator: true },
  { key: 'skills', label: '技能库', icon: '⚡' },
  { key: 'clawhub', label: 'ClawHub 商店', icon: '🛒' },
  { key: 'mcps', label: 'MCP库', icon: '⬢' },
  { key: 'tasks', label: '任务', icon: '▶', separator: true },
  { key: 'cron', label: '定时任务', icon: '⏰' },
  { key: 'channels', label: '渠道', icon: '🔗' },
]

export default function Layout({
  currentPage,
  onNavigate,
  children,
}: {
  currentPage: Page
  onNavigate: (page: Page) => void
  children: ReactNode
}) {
  return (
    <div className="flex h-screen bg-[#0f172a] text-[#f1f5f9]">
      <aside className="w-56 shrink-0 bg-[#1e293b] border-r border-[#334155] flex flex-col">
        <div className="p-4 border-b border-[#334155]">
          <h1 className="text-lg font-bold tracking-wide">NMClaw</h1>
          <p className="text-xs text-[#94a3b8] mt-0.5">Agent 调度平台</p>
        </div>
        <nav className="flex-1 p-2 space-y-0.5 overflow-auto">
          {NAV_ITEMS.map((item, i) => (
            <div key={item.key}>
              {item.separator && i > 0 && <div className="my-2 border-t border-[#334155]/50" />}
              <button
                onClick={() => onNavigate(item.key)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center gap-2.5 transition-colors ${
                  currentPage === item.key
                    ? 'bg-[#3b82f6] text-white'
                    : 'text-[#94a3b8] hover:bg-[#334155] hover:text-[#f1f5f9]'
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </button>
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-[#334155] text-xs text-[#64748b]">
          v0.1.0
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  )
}
