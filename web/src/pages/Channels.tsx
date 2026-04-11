import { useEffect, useState } from 'react'
import { api } from '../api'

const emptyFeishuConfig = {
  mode: 'websocket' as string,
  appId: '', appSecret: '', domain: 'feishu' as string, streaming: true,
  webhookUrl: '', webhookSecret: '',
  encryptKey: '', verificationToken: '',
  requireMention: false, groupPolicy: 'open' as string, allowedUsers: [] as string[],
}

export default function Channels() {
  const [channels, setChannels] = useState<any[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', type: 'feishu' as string, agentId: '', config: { ...emptyFeishuConfig } })
  const [testText, setTestText] = useState('')
  const [testingId, setTestingId] = useState<string | null>(null)
  const [pairings, setPairings] = useState<any[]>([])
  const [showPairings, setShowPairings] = useState(false)

  const load = async () => {
    const [chs, ags] = await Promise.all([
      api.listChannels().catch(() => []),
      api.listAgents(),
    ])
    setChannels(chs)
    setAgents(ags)
    const sts: Record<string, string> = {}
    for (const ch of chs) {
      if (ch.config?.mode === 'websocket') {
        try {
          const s = await api.getChannelStatus(ch.id)
          sts[ch.id] = s.status
        } catch { sts[ch.id] = 'unknown' }
      }
    }
    setStatuses(sts)
  }

  const loadPairings = async () => {
    try {
      const ps = await api.listPairings()
      setPairings(ps)
    } catch { setPairings([]) }
  }

  useEffect(() => { load() }, [])

  const cancelForm = () => { setShowForm(false); setEditId(null); setForm({ name: '', type: 'feishu', agentId: '', config: { ...emptyFeishuConfig } }) }

  const startEdit = (ch: any) => {
    setEditId(ch.id)
    setForm({ name: ch.name, type: ch.type, agentId: ch.agentId, config: { ...emptyFeishuConfig, ...ch.config } })
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.name || !form.agentId) return
    if (editId) {
      await api.modifyChannel(editId, { ...form })
    } else {
      await api.addChannel({ ...form })
    }
    cancelForm()
    load()
  }

  const handleToggle = async (ch: any) => {
    await api.modifyChannel(ch.id, { enabled: !ch.enabled })
    load()
  }

  const handleRemove = async (id: string) => {
    if (!confirm('确认删除此渠道?')) return
    await api.removeChannel(id)
    load()
  }

  const handleStart = async (id: string) => {
    try {
      await api.startChannel(id)
      load()
    } catch (err) { alert(`启动失败: ${err instanceof Error ? err.message : err}`) }
  }

  const handleStop = async (id: string) => {
    await api.stopChannel(id)
    load()
  }

  const handleTest = async (id: string) => {
    if (!testText.trim()) return
    try {
      await api.sendChannelMessage(id, testText)
      setTestText('')
      setTestingId(null)
    } catch (err) { alert(`发送失败: ${err instanceof Error ? err.message : err}`) }
  }

  const handleApprovePairing = async (code: string) => {
    try {
      await api.approvePairing(code)
      loadPairings()
      load()
    } catch (err) { alert(`审批失败: ${err instanceof Error ? err.message : err}`) }
  }

  const handleRejectPairing = async (code: string) => {
    try {
      await api.rejectPairing(code)
      loadPairings()
    } catch (err) { alert(`拒绝失败: ${err instanceof Error ? err.message : err}`) }
  }

  const activeAgents = agents.filter((a: any) => a.state !== 'destroyed')
  const cfg = form.config
  const pendingPairings = pairings.filter((p: any) => p.status === 'pending')

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">渠道管理</h2>
          <p className="text-xs text-[#64748b] mt-1">连接飞书、企业微信等 IM 平台，让 Agent 接收和回复消息</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setShowPairings(!showPairings); if (!showPairings) loadPairings() }}
            className="px-3 py-1.5 bg-[#334155] hover:bg-[#475569] rounded-md text-sm transition-colors relative">
            配对管理
            {pendingPairings.length > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-[10px] flex items-center justify-center">
                {pendingPairings.length}
              </span>
            )}
          </button>
          <button onClick={() => showForm ? cancelForm() : setShowForm(true)}
            className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
            {showForm ? '取消' : '+ 新建渠道'}
          </button>
        </div>
      </div>

      {showPairings && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-[#94a3b8]">配对请求</div>
            <button onClick={loadPairings} className="text-xs text-[#3b82f6] hover:text-[#60a5fa]">刷新</button>
          </div>
          {pairings.length === 0 ? (
            <p className="text-sm text-[#64748b]">暂无配对请求</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#334155] text-[#94a3b8] text-xs">
                  <th className="text-left p-2">配对码</th>
                  <th className="text-left p-2">用户 ID</th>
                  <th className="text-left p-2">渠道</th>
                  <th className="text-left p-2">状态</th>
                  <th className="text-left p-2">时间</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {pairings.map((p: any) => {
                  const ch = channels.find((c: any) => c.id === p.channelId)
                  return (
                    <tr key={p.code} className="border-b border-[#334155]/50">
                      <td className="p-2 font-mono text-[#f1f5f9]">{p.code}</td>
                      <td className="p-2 font-mono text-xs text-[#94a3b8]">{p.userName || p.userId}</td>
                      <td className="p-2 text-xs">{ch?.name || p.channelId}</td>
                      <td className="p-2">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          p.status === 'pending' ? 'bg-[#f59e0b]/20 text-[#f59e0b]' :
                          p.status === 'approved' ? 'bg-[#22c55e]/20 text-[#22c55e]' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {p.status === 'pending' ? '待审批' : p.status === 'approved' ? '已通过' : '已拒绝'}
                        </span>
                      </td>
                      <td className="p-2 text-xs text-[#64748b]">{new Date(p.createdAt).toLocaleString('zh-CN')}</td>
                      <td className="p-2 text-right space-x-2">
                        {p.status === 'pending' && (
                          <>
                            <button onClick={() => handleApprovePairing(p.code)}
                              className="text-xs text-[#22c55e] hover:text-[#4ade80]">通过</button>
                            <button onClick={() => handleRejectPairing(p.code)}
                              className="text-xs text-red-400 hover:text-red-300">拒绝</button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showForm && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div className="text-xs text-[#94a3b8] mb-1">{editId ? '编辑渠道' : '新建渠道'}</div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">渠道名称</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="飞书-研发群" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">平台</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}
                className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
                <option value="feishu">飞书</option>
                <option value="telegram">Telegram</option>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
                <option value="wecom">企业微信</option>
                <option value="dingtalk">钉钉</option>
                <option value="wechat">微信公众号</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">绑定 Agent</label>
              <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}
                className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
                <option value="">选择 Agent</option>
                {activeAgents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>

          {form.type === 'feishu' && (
            <>
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">连接模式</label>
                <div className="flex gap-2">
                  {(['websocket', 'webhook'] as const).map((m) => (
                    <button key={m} onClick={() => setForm({ ...form, config: { ...cfg, mode: m } })}
                      className={`px-3 py-1.5 rounded text-xs transition-colors ${cfg.mode === m ? 'bg-[#3b82f6] text-white' : 'bg-[#334155] text-[#94a3b8] hover:bg-[#475569]'}`}>
                      {m === 'websocket' ? 'WebSocket 长连接 (推荐)' : 'Webhook (仅发送)'}
                    </button>
                  ))}
                </div>
              </div>

              {cfg.mode === 'websocket' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#94a3b8] mb-1">App ID</label>
                      <input value={cfg.appId} onChange={(e) => setForm({ ...form, config: { ...cfg, appId: e.target.value } })}
                        placeholder="cli_xxx" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#94a3b8] mb-1">App Secret</label>
                      <input value={cfg.appSecret} onChange={(e) => setForm({ ...form, config: { ...cfg, appSecret: e.target.value } })}
                        type="password" placeholder="App Secret"
                        className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#94a3b8] mb-1">域名</label>
                      <select value={cfg.domain || 'feishu'} onChange={(e) => setForm({ ...form, config: { ...cfg, domain: e.target.value } })}
                        className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
                        <option value="feishu">飞书 (国内)</option>
                        <option value="lark">Lark (国际版)</option>
                      </select>
                    </div>
                    <div className="flex items-end pb-1">
                      <label className="flex items-center gap-2 text-xs text-[#94a3b8] cursor-pointer">
                        <input type="checkbox" checked={cfg.streaming !== false}
                          onChange={(e) => setForm({ ...form, config: { ...cfg, streaming: e.target.checked } })}
                          className="rounded" />
                        流式卡片回复 (实时打字效果)
                      </label>
                    </div>
                  </div>

                  {/* Access Control */}
                  <div className="border-t border-[#334155] pt-3">
                    <div className="text-xs text-[#94a3b8] mb-2 font-medium">访问控制</div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-[#94a3b8] mb-1">群聊策略</label>
                        <select value={cfg.groupPolicy || 'open'} onChange={(e) => setForm({ ...form, config: { ...cfg, groupPolicy: e.target.value } })}
                          className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
                          <option value="open">开放 (所有人可用)</option>
                          <option value="allowlist">白名单 (需配对审批)</option>
                        </select>
                      </div>
                      <div className="flex items-end pb-1">
                        <label className="flex items-center gap-2 text-xs text-[#94a3b8] cursor-pointer">
                          <input type="checkbox" checked={cfg.requireMention || false}
                            onChange={(e) => setForm({ ...form, config: { ...cfg, requireMention: e.target.checked } })}
                            className="rounded" />
                          群聊中需要 @机器人 才回复
                        </label>
                      </div>
                    </div>
                    {cfg.groupPolicy === 'allowlist' && (
                      <div className="mt-2 bg-[#0f172a] rounded p-2 text-xs text-[#94a3b8]">
                        白名单模式：未授权用户发消息时会收到配对码，管理员在「配对管理」中审批后即可使用。
                        {(cfg.allowedUsers || []).length > 0 && (
                          <div className="mt-1 text-[#f1f5f9]">
                            已授权 {cfg.allowedUsers.length} 个用户
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#94a3b8] mb-1">Encrypt Key</label>
                      <input value={cfg.encryptKey || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, encryptKey: e.target.value } })}
                        type="password" placeholder="事件加密密钥（开发者后台 → 事件与回调 → 加密策略）"
                        className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#94a3b8] mb-1">Verification Token</label>
                      <input value={cfg.verificationToken || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, verificationToken: e.target.value } })}
                        placeholder="事件验证 Token（开发者后台 → 事件与回调 → 加密策略）"
                        className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
                    </div>
                  </div>
                  <div className="bg-[#0f172a] rounded p-3 text-xs text-[#94a3b8] space-y-1">
                    <p className="text-[#f1f5f9] font-medium">飞书开放平台配置步骤：</p>
                    <p>1. 访问 <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="text-[#3b82f6] hover:underline">open.feishu.cn/app</a> 创建企业自建应用</p>
                    <p>2. 添加「机器人」能力，复制 App ID 和 App Secret</p>
                    <p>3. 事件订阅 → 选择「使用长连接接收事件」(WebSocket)</p>
                    <p>4. 添加事件：<code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">im.message.receive_v1</code></p>
                    <p>5. 权限管理 → 开通 <code className="text-[#f1f5f9] font-mono">im:message:send_as_bot</code>、<code className="text-[#f1f5f9] font-mono">im:message</code>、<code className="text-[#f1f5f9] font-mono">im:resource</code></p>
                    <p>6. 发布应用并等待审批通过</p>
                    <p className="text-[#22c55e] mt-1">无需公网 URL，WebSocket 长连接自动建立</p>
                  </div>
                </div>
              )}

              {cfg.mode === 'webhook' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#94a3b8] mb-1">Webhook URL</label>
                    <input value={cfg.webhookUrl} onChange={(e) => setForm({ ...form, config: { ...cfg, webhookUrl: e.target.value } })}
                      placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
                      className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#94a3b8] mb-1">签名密钥 (可选)</label>
                    <input value={cfg.webhookSecret} onChange={(e) => setForm({ ...form, config: { ...cfg, webhookSecret: e.target.value } })}
                      placeholder="签名校验密钥" type="password"
                      className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
                  </div>
                </div>
              )}
            </>
          )}

          {form.type === 'telegram' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">Bot Token</label>
                <input value={cfg.botToken || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, botToken: e.target.value } })}
                  placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                  className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
              </div>
              <div className="bg-[#0f172a] rounded p-3 text-xs text-[#94a3b8] space-y-1">
                <p className="text-[#f1f5f9] font-medium">Telegram Bot 配置步骤：</p>
                <p>1. 在 Telegram 中搜索 <code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">@BotFather</code> 并发送 <code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">/newbot</code></p>
                <p>2. 按提示设置名称，获取 Bot Token</p>
                <p>3. 粘贴到上方输入框</p>
                <p className="text-[#22c55e] mt-1">使用 Long Polling 模式，无需公网 URL</p>
              </div>
            </div>
          )}

          {form.type === 'discord' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">Bot Token</label>
                <input value={cfg.botToken || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, botToken: e.target.value } })}
                  placeholder="MTAxNTI..."
                  className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
              </div>
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">Guild ID (可选，限定服务器)</label>
                <input value={cfg.guildId || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, guildId: e.target.value } })}
                  placeholder="留空则响应所有服务器"
                  className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
              </div>
              <div className="bg-[#0f172a] rounded p-3 text-xs text-[#94a3b8] space-y-1">
                <p className="text-[#f1f5f9] font-medium">Discord Bot 配置步骤：</p>
                <p>1. 访问 <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="text-[#3b82f6] hover:underline">Discord Developer Portal</a> 创建应用</p>
                <p>2. Bot → Reset Token → 复制 Token</p>
                <p>3. Bot → 开启 MESSAGE CONTENT INTENT</p>
                <p>4. OAuth2 → URL Generator → 勾选 bot + Send Messages + Read Message History</p>
                <p>5. 用生成的链接邀请 Bot 到服务器</p>
                <p className="text-[#22c55e] mt-1">频道中需要 @Bot 才会回复，DM 直接回复</p>
              </div>
            </div>
          )}

          {form.type === 'slack' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">Bot Token</label>
                  <input value={cfg.botToken || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, botToken: e.target.value } })}
                    placeholder="xoxb-..."
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">App Token</label>
                  <input value={cfg.appToken || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, appToken: e.target.value } })}
                    placeholder="xapp-..."
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">Signing Secret</label>
                <input value={cfg.signingSecret || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, signingSecret: e.target.value } })}
                  type="password" placeholder="Signing Secret"
                  className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
              </div>
              <div className="bg-[#0f172a] rounded p-3 text-xs text-[#94a3b8] space-y-1">
                <p className="text-[#f1f5f9] font-medium">Slack App 配置步骤：</p>
                <p>1. 访问 <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="text-[#3b82f6] hover:underline">api.slack.com/apps</a> 创建应用</p>
                <p>2. Basic Information → Signing Secret</p>
                <p>3. OAuth & Permissions → Bot Token Scopes: <code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">chat:write</code> <code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">app_mentions:read</code> <code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">im:history</code></p>
                <p>4. Socket Mode → 开启 → 生成 App Token</p>
                <p>5. Event Subscriptions → 订阅 <code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">message.im</code> <code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">app_mention</code></p>
                <p className="text-[#22c55e] mt-1">Socket Mode 无需公网 URL</p>
              </div>
            </div>
          )}

          {form.type === 'wecom' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">Corp ID</label>
                  <input value={cfg.corpId || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, corpId: e.target.value } })}
                    placeholder="ww..."
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">Bot ID</label>
                  <input value={cfg.botId || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, botId: e.target.value } })}
                    placeholder="Bot ID"
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">Secret</label>
                <input value={cfg.secret || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, secret: e.target.value } })}
                  type="password" placeholder="应用 Secret"
                  className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
              </div>
              <div className="bg-[#0f172a] rounded p-3 text-xs text-[#94a3b8] space-y-1">
                <p className="text-[#f1f5f9] font-medium">企业微信机器人配置步骤：</p>
                <p>1. 访问 <a href="https://work.weixin.qq.com/wework_admin/frame#apps" target="_blank" rel="noreferrer" className="text-[#3b82f6] hover:underline">企业微信管理后台</a> → 应用管理 → 创建应用</p>
                <p>2. 获取 Corp ID（我的企业 → 企业信息）和应用 Secret</p>
                <p>3. 开启机器人能力，获取 Bot ID</p>
                <p className="text-[#22c55e] mt-1">WebSocket 长连接模式，无需公网 URL</p>
              </div>
            </div>
          )}

          {form.type === 'dingtalk' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">App Key</label>
                  <input value={cfg.appKey || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, appKey: e.target.value } })}
                    placeholder="ding..."
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">App Secret</label>
                  <input value={cfg.appSecret || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, appSecret: e.target.value } })}
                    type="password" placeholder="App Secret"
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">Robot Code</label>
                <input value={cfg.robotCode || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, robotCode: e.target.value } })}
                  placeholder="机器人 Code"
                  className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
              </div>
              <div className="bg-[#0f172a] rounded p-3 text-xs text-[#94a3b8] space-y-1">
                <p className="text-[#f1f5f9] font-medium">钉钉机器人配置步骤：</p>
                <p>1. 访问 <a href="https://open-dev.dingtalk.com" target="_blank" rel="noreferrer" className="text-[#3b82f6] hover:underline">钉钉开放平台</a> 创建应用</p>
                <p>2. 添加「机器人」能力，获取 App Key / App Secret / Robot Code</p>
                <p>3. 消息接收模式选择「Stream 模式」</p>
                <p className="text-[#22c55e] mt-1">Stream 模式长连接，无需公网 URL，自动重连</p>
              </div>
            </div>
          )}

          {form.type === 'wechat' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">App ID</label>
                  <input value={cfg.appId || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, appId: e.target.value } })}
                    placeholder="wx..."
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">App Secret</label>
                  <input value={cfg.appSecret || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, appSecret: e.target.value } })}
                    type="password" placeholder="App Secret"
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">Token</label>
                  <input value={cfg.token || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, token: e.target.value } })}
                    placeholder="自定义 Token"
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-[#94a3b8] mb-1">EncodingAESKey</label>
                  <input value={cfg.encodingAESKey || ''} onChange={(e) => setForm({ ...form, config: { ...cfg, encodingAESKey: e.target.value } })}
                    placeholder="消息加解密密钥"
                    className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
                </div>
              </div>
              <div className="bg-[#0f172a] rounded p-3 text-xs text-[#94a3b8] space-y-1">
                <p className="text-[#f1f5f9] font-medium">微信公众号配置步骤：</p>
                <p>1. 访问 <a href="https://mp.weixin.qq.com" target="_blank" rel="noreferrer" className="text-[#3b82f6] hover:underline">微信公众平台</a> → 开发 → 基本配置</p>
                <p>2. 获取 AppID 和 AppSecret</p>
                <p>3. 服务器配置 → 填写服务器 URL: <code className="text-[#f1f5f9] font-mono bg-[#334155] px-1 rounded">https://你的域名/api/channels/wechat/callback</code></p>
                <p>4. 设置 Token 和 EncodingAESKey</p>
                <p className="text-yellow-400 mt-1">⚠ 需要公网 URL。超过 5 秒的回复会通过客服消息接口异步发送</p>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={handleSave} disabled={!form.name || !form.agentId}
              className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
              {editId ? '保存' : '创建'}
            </button>
            {editId && <button onClick={cancelForm} className="px-4 py-1.5 bg-[#334155] hover:bg-[#475569] rounded-md text-sm transition-colors">取消</button>}
          </div>
        </div>
      )}

      <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
        {channels.length === 0 ? (
          <p className="text-sm text-[#64748b] p-4">暂无渠道 — 点击「新建渠道」连接飞书等 IM 平台</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#334155] text-[#94a3b8] text-xs uppercase">
                <th className="text-left p-3">状态</th>
                <th className="text-left p-3">名称</th>
                <th className="text-left p-3">平台</th>
                <th className="text-left p-3">模式</th>
                <th className="text-left p-3">连接</th>
                <th className="text-left p-3">访问</th>
                <th className="text-left p-3">绑定 Agent</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch: any) => {
                const agent = agents.find((a: any) => a.id === ch.agentId)
                const feishuCfg = ch.config || {}
                const isWs = feishuCfg.mode === 'websocket'
                const wsStatus = statuses[ch.id]
                return (
                  <tr key={ch.id} className="border-b border-[#334155]/50 hover:bg-[#334155]/30">
                    <td className="p-3">
                      <button onClick={() => handleToggle(ch)}
                        className={`w-8 h-4 rounded-full relative transition-colors ${ch.enabled ? 'bg-[#22c55e]' : 'bg-[#475569]'}`}>
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${ch.enabled ? 'left-4' : 'left-0.5'}`} />
                      </button>
                    </td>
                    <td className="p-3">{ch.name}</td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded text-xs bg-[#334155]">
                        {ch.type === 'feishu' ? '飞书' : ch.type === 'wecom' ? '企业微信' : ch.type}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-[#94a3b8]">
                      {isWs ? 'WebSocket' : feishuCfg.mode === 'webhook' ? 'Webhook' : '-'}
                    </td>
                    <td className="p-3">
                      {isWs && (
                        <span className="flex items-center gap-1.5 text-xs">
                          <span className={`w-2 h-2 rounded-full ${wsStatus === 'running' ? 'bg-[#22c55e]' : 'bg-[#64748b]'}`} />
                          <span className={wsStatus === 'running' ? 'text-[#22c55e]' : 'text-[#64748b]'}>
                            {wsStatus === 'running' ? '已连接' : '未连接'}
                          </span>
                        </span>
                      )}
                      {!isWs && <span className="text-xs text-[#64748b]">-</span>}
                    </td>
                    <td className="p-3 text-xs">
                      {feishuCfg.groupPolicy === 'allowlist' ? (
                        <span className="px-2 py-0.5 rounded bg-[#f59e0b]/20 text-[#f59e0b]">
                          白名单 ({(feishuCfg.allowedUsers || []).length})
                        </span>
                      ) : (
                        <span className="text-[#64748b]">开放</span>
                      )}
                    </td>
                    <td className="p-3 text-xs">{agent?.name || ch.agentId}</td>
                    <td className="p-3 text-right space-x-2">
                      {isWs && wsStatus !== 'running' && ch.enabled && (
                        <button onClick={() => handleStart(ch.id)} className="text-xs text-[#22c55e] hover:text-[#4ade80]">启动</button>
                      )}
                      {isWs && wsStatus === 'running' && (
                        <button onClick={() => handleStop(ch.id)} className="text-xs text-[#f59e0b] hover:text-[#fbbf24]">停止</button>
                      )}
                      {feishuCfg.mode === 'webhook' && (
                        testingId === ch.id ? (
                          <span className="inline-flex items-center gap-1">
                            <input value={testText} onChange={(e) => setTestText(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleTest(ch.id)}
                              placeholder="输入测试消息" autoFocus
                              className="bg-[#0f172a] border border-[#475569] rounded px-2 py-0.5 text-xs w-40 outline-none focus:border-[#3b82f6]" />
                            <button onClick={() => handleTest(ch.id)} className="text-xs text-[#22c55e] hover:text-[#4ade80]">发送</button>
                            <button onClick={() => { setTestingId(null); setTestText('') }} className="text-xs text-[#64748b] hover:text-[#94a3b8]">取消</button>
                          </span>
                        ) : (
                          <button onClick={() => setTestingId(ch.id)} className="text-xs text-[#22c55e] hover:text-[#4ade80]">测试</button>
                        )
                      )}
                      <button onClick={() => startEdit(ch)} className="text-xs text-[#3b82f6] hover:text-[#60a5fa]">编辑</button>
                      <button onClick={() => handleRemove(ch.id)} className="text-xs text-red-400 hover:text-red-300">删除</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
