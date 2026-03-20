# Agent 调度平台 — 开发需求文档

> 核心理念：创世Agent是平台内核，不是模拟Agent。它只调度，不执行。所有执行权限归用户所有。

---

## 1. 系统架构概览

```
┌─────────────────────────────────────────────────────┐
│                    用户 (User)                       │
│         所有创建/销毁/修改权限的最终决策者              │
└──────────────────────┬──────────────────────────────┘
                       │ 授权 / Bypass模式
                       ▼
┌─────────────────────────────────────────────────────┐
│              创世Agent (Genesis Agent)               │
│                    — 平台内核 —                       │
│  · 需求解析与分解                                     │
│  · Agent 增减配调度                                   │
│  · 任务下发与流转编排                                  │
│  · 无应用执行权限，仅有调度权限                         │
└──────────┬──────────────┬───────────────┬───────────┘
           │              │               │
     ┌─────▼─────┐ ┌─────▼─────┐  ┌──────▼─────┐
     │ Worker A  │ │ Worker B  │  │ Worker C   │
     │ Model: X  │ │ Model: Y  │  │ Model: Z   │
     │ Skills:.. │ │ Skills:.. │  │ Skills:..  │
     │ MCPs: ..  │ │ MCPs: ..  │  │ MCPs: ..   │
     └───────────┘ └───────────┘  └────────────┘
           │              │               │
     ┌─────▼──────────────▼───────────────▼───────────┐
     │              共享资源库 (Shared Libraries)        │
     │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
     │  │ 模型库   │ │ 技能库   │ │ MCP 库   │        │
     │  └──────────┘ └──────────┘ └──────────┘        │
     └────────────────────────────────────────────────┘
```

---

## 2. 核心模块需求

### 2.1 创世Agent (Genesis Agent)

创世Agent不是一个"聪明的Agent"，它是系统内核。类比Linux内核——管进程调度，不跑用户态程序。

**职责边界：**

| 能做 | 不能做 |
|------|--------|
| 解析用户需求 | 直接执行业务任务 |
| 判断是否需要增员 | 未经授权创建Agent |
| 下发任务到Worker Agent | 访问外部API/服务 |
| 编排Agent间的数据流转 | 修改共享资源库内容 |
| 监控Agent生命周期状态 | 绕过用户权限决策 |

**需求处理流程：**

```
用户需求输入
    │
    ▼
创世Agent 解析需求
    │
    ├─ 现有Agent可处理 ──→ 直接派发任务
    │
    └─ 需要新能力 ──→ 向用户申请创建新Agent
                          │
                          ├─ 用户同意 ──→ 从资源库装配Agent → 派发任务
                          └─ 用户拒绝 ──→ 反馈替代方案或终止
```

### 2.2 Worker Agent (员工Agent)

每个Worker Agent是一个独立的执行单元，从共享资源库中按需装配能力。

**Agent 定义结构：**

```yaml
agent:
  id: "agent-uuid"
  name: "数据分析员"
  description: "负责处理数据清洗和分析任务"

  # 从模型库选择
  model:
    id: "claude-sonnet-4-6"
    parameters:
      temperature: 0.3
      max_tokens: 4096

  # 从技能库选择
  skills:
    - "data-cleaning"
    - "csv-parsing"
    - "chart-generation"

  # 从MCP库选择
  mcps:
    - "mcp-filesystem"
    - "mcp-database"

  # 生命周期配置
  lifecycle:
    ttl: "7d"                    # 默认7天生存期
    idle_timeout: "24h"          # 空闲超时自动销毁
    auto_renew: false            # 是否自动续期

  # 系统提示词
  system_prompt: "你是一个数据分析专家..."
```

**生命周期状态机：**

```
[创建请求] → 用户授权 → [Active] ⇄ [Idle]
                                        │
                          idle_timeout到期 │
                                        ▼
                                   [Pending Destroy]
                                        │
                              ┌─────────┼─────────┐
                              ▼                   ▼
                        用户确认销毁          用户续期
                              │                   │
                              ▼                   ▼
                        [Destroyed]          [Active]

TTL到期 → 强制进入 [Pending Destroy]
```

### 2.3 共享资源库

资源库是平台的基础设施层。Agent不拥有能力，Agent从库中借用能力。

#### 2.3.1 模型库 (Model Registry)

```yaml
models:
  - id: "claude-opus-4-6"
    provider: "anthropic"
    capabilities: ["reasoning", "coding", "analysis"]
    cost_tier: "high"
    config:
      api_key_ref: "env:ANTHROPIC_API_KEY"
      base_url: "https://api.anthropic.com"

  - id: "claude-sonnet-4-6"
    provider: "anthropic"
    capabilities: ["coding", "general"]
    cost_tier: "medium"
    config:
      api_key_ref: "env:ANTHROPIC_API_KEY"

  - id: "deepseek-r1"
    provider: "deepseek"
    capabilities: ["reasoning", "math"]
    cost_tier: "low"
    config:
      api_key_ref: "env:DEEPSEEK_API_KEY"
      base_url: "https://api.deepseek.com"

  - id: "local-llama"
    provider: "ollama"
    capabilities: ["general"]
    cost_tier: "free"
    config:
      base_url: "http://localhost:11434"
```

**模型库功能：**
- 注册/注销模型
- 模型能力标签（reasoning, coding, analysis, general...）
- 成本分级（high/medium/low/free），供创世Agent做调度决策
- 健康检查（模型是否可用）
- 用量统计（token消耗追踪）

#### 2.3.2 技能库 (Skill Registry)

技能 = 可复用的Prompt模板 + 工具链 + 约束条件。

```yaml
skills:
  - id: "code-review"
    name: "代码审查"
    description: "对代码进行质量审查，输出问题列表和改进建议"
    prompt_template: |
      你是一个代码审查专家。请对以下代码进行审查：
      {{code}}
      重点关注：安全性、性能、可读性。
    required_mcps: ["mcp-filesystem"]     # 依赖的MCP
    compatible_models: ["*"]               # 兼容的模型，*表示全部
    input_schema:
      code: { type: "string", required: true }
    output_schema:
      issues: { type: "array" }
      score: { type: "number" }

  - id: "data-cleaning"
    name: "数据清洗"
    description: "清洗和标准化数据集"
    # ...
```

**技能库功能：**
- 注册/注销/版本管理技能
- 技能依赖声明（需要哪些MCP）
- 技能兼容性（适配哪些模型）
- 技能组合（多个技能可以编排成pipeline）

#### 2.3.3 MCP库 (MCP Registry)

```yaml
mcps:
  - id: "mcp-filesystem"
    name: "文件系统"
    description: "读写本地文件系统"
    transport: "stdio"
    command: "npx"
    args: ["-y", "@anthropic/mcp-filesystem"]
    permissions:
      - "read"
      - "write"

  - id: "mcp-database"
    name: "数据库"
    description: "连接和查询数据库"
    transport: "sse"
    url: "http://localhost:3001/mcp"
    permissions:
      - "query"
      - "write"

  - id: "mcp-playwright"
    name: "浏览器自动化"
    transport: "stdio"
    command: "npx"
    args: ["@anthropic/mcp-playwright"]
    permissions:
      - "navigate"
      - "screenshot"
```

**MCP库功能：**
- 注册/注销MCP服务
- 连接池管理（多个Agent共享同一MCP实例 vs 独立实例）
- 权限声明（每个MCP暴露哪些能力）
- 健康检查与自动重连

---

## 3. 用户权限体系

### 3.1 权限模型

所有关键操作的最终决策权归用户。

```
权限层级：

[用户] ─── 拥有一切权限
   │
   ├── Agent 管理权限
   │     ├── 创建Agent        (必须用户授权)
   │     ├── 销毁Agent        (必须用户授权)
   │     ├── 修改Agent配置     (必须用户授权)
   │     └── 查看Agent状态     (默认开放)
   │
   ├── 资源库管理权限
   │     ├── 添加/移除模型      (必须用户授权)
   │     ├── 添加/移除技能      (必须用户授权)
   │     └── 添加/移除MCP      (必须用户授权)
   │
   └── 执行权限
         ├── 任务审批          (默认需要，Bypass模式可跳过)
         └── 数据访问          (按MCP权限控制)
```

### 3.2 Bypass 模式

用户可以开启Bypass模式，让创世Agent在预设规则内自主决策，跳过逐次确认。

```yaml
bypass:
  enabled: true
  rules:
    # 允许自动创建cost_tier为low/free的Agent
    auto_create_agent:
      condition: "agent.model.cost_tier in ['low', 'free']"

    # 允许自动销毁idle超过48h的Agent
    auto_destroy_agent:
      condition: "agent.state == 'idle' && agent.idle_duration > '48h'"

    # 允许自动派发不涉及写操作的任务
    auto_dispatch_task:
      condition: "task.permissions.every(p => p == 'read')"

    # 以下操作永远不能bypass
    never_bypass:
      - "delete_data"
      - "modify_model_registry"
      - "access_credentials"
```

---

## 4. Agent Graph — 可视化编排

### 4.1 Graph 数据模型

```yaml
graph:
  id: "workflow-001"
  name: "用户反馈处理流水线"

  nodes:
    - id: "intake"
      agent_id: "agent-001"        # 需求分类Agent
      role: "对用户反馈进行分类"

    - id: "analyzer"
      agent_id: "agent-002"        # 数据分析Agent
      role: "分析反馈数据趋势"

    - id: "responder"
      agent_id: "agent-003"        # 回复生成Agent
      role: "生成回复建议"

  edges:
    - from: "intake"
      to: "analyzer"
      condition: "output.category == 'bug'"
      data_mapping:
        feedback_text: "input.raw_text"

    - from: "intake"
      to: "responder"
      condition: "output.category == 'feature_request'"
      data_mapping:
        request_summary: "input.summary"

    - from: "analyzer"
      to: "responder"
      data_mapping:
        analysis_result: "input.analysis"
```

### 4.2 Graph 功能需求

- 可视化拖拽编排Agent节点和连线
- 条件分支（基于Agent输出决定下一步流转）
- 数据映射（定义节点间的数据传递规则）
- 并行执行（无依赖的节点可并行运行）
- 循环/重试（失败时可配置重试策略）
- 子图（Graph可嵌套，复杂流程可拆分）

---

## 5. Tracker & Dashboard — 可观测性

### 5.1 Tracker（数据流追踪）

每个任务执行过程生成完整的trace，让用户清楚知道数据在哪里流转。

```yaml
trace:
  task_id: "task-20260320-001"
  initiated_by: "user"
  timestamp: "2026-03-20T10:30:00Z"

  spans:
    - span_id: "span-001"
      agent: "Genesis Agent"
      action: "需求解析"
      input: "帮我分析这份销售数据"
      output: "需要数据分析Agent，当前无可用Agent"
      decision: "申请创建新Agent"
      duration_ms: 1200
      tokens_used: 450

    - span_id: "span-002"
      agent: "Genesis Agent"
      action: "用户授权请求"
      request: "创建数据分析Agent (model: claude-sonnet-4-6, skills: [data-cleaning, csv-parsing])"
      response: "用户同意"
      duration_ms: 15000    # 等待用户确认

    - span_id: "span-003"
      agent: "数据分析员 (agent-004)"
      action: "执行数据分析"
      input: "sales_2026_q1.csv"
      output: "分析报告已生成"
      duration_ms: 8500
      tokens_used: 3200
      mcps_used: ["mcp-filesystem"]
```

### 5.2 Dashboard（总览面板）

Dashboard是用户的"指挥中心"，一眼看清全局。

**面板内容：**

| 区域 | 展示内容 |
|------|---------|
| Agent 总览 | 所有Agent的状态（Active/Idle/Pending Destroy），剩余TTL |
| 任务队列 | 当前进行中的任务、排队中的任务、已完成的任务 |
| 数据流图 | 实时展示当前任务的数据在哪些Agent间流转 |
| Token 消耗 | 按Agent/模型/时间维度的token用量统计 |
| 待审批项 | 需要用户确认的操作（创建Agent、敏感任务等） |
| 资源库状态 | 模型/技能/MCP的可用性和使用情况 |

---

## 6. 技术选型建议

| 层级 | 建议 | 理由 |
|------|------|------|
| 运行时 | Node.js / TypeScript | MCP生态原生支持，类型安全 |
| Agent通信 | 事件驱动 (EventEmitter / Message Queue) | Agent间解耦，支持异步流转 |
| 持久化 | SQLite (本地) / PostgreSQL (部署) | 轻量启动，可扩展 |
| Graph引擎 | 自研DAG执行器 | 控制力强，避免过度依赖 |
| Dashboard | Web UI (React / Vue) | 可视化编排需要丰富交互 |
| MCP管理 | MCP SDK (@modelcontextprotocol/sdk) | 官方SDK，协议兼容 |

---

## 7. 开发阶段规划

### Phase 1 — 内核 (MVP)
- 创世Agent核心调度逻辑
- Worker Agent生命周期管理（创建/销毁/TTL）
- 模型库（支持注册多个模型，Agent可选择模型）
- 用户权限确认流程（非Bypass模式）
- CLI交互界面

### Phase 2 — 资源库
- 技能库完整实现（注册/版本/依赖）
- MCP库完整实现（注册/连接池/健康检查）
- Bypass模式与规则引擎
- Agent配置热更新（不销毁Agent的情况下修改配置）

### Phase 3 — 编排与可视化
- Agent Graph数据模型与DAG执行器
- Tracker数据采集与存储
- Dashboard Web UI
- 可视化拖拽编排

### Phase 4 — 生产化
- Agent摘要自动生成（可解释性）
- Token用量分析与成本优化建议
- 多用户支持
- 部署方案（Docker / 云端）

---

## 8. 核心设计原则

1. **创世Agent是内核，不是God Agent** — 它不思考业务，只调度资源
2. **Agent不拥有能力，Agent借用能力** — 所有能力来自共享资源库
3. **用户是唯一的权力中心** — 创建、销毁、修改，最终决策权永远在用户手里
4. **可观测性不是附加功能** — Tracker和Dashboard是一等公民，从Day 1就要有
5. **生命周期是硬约束** — Agent不是永生的，idle就销毁，TTL到期就回收
