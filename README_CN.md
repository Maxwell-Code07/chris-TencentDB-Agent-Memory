[English](README.md)

<h1 align="center">TencentDB Agent Memory</h1>

<p align="center">没有记忆的AI，只是工具；有记忆的AI，才是资产。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tencentdb-agent-memory/memory-tencentdb"><img src="https://img.shields.io/badge/OpenClaw-Plugin-6C63FF?logo=npm&logoColor=white" alt="OpenClaw Plugin" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA043?logo=opensourceinitiative&logoColor=white" alt="MIT License" /></a>
</p>


**TencentDB Agent Memory是腾讯云数据库团队自研的 Agent 记忆系统**，为 OpenClaw 补上长期连续的记忆。通过四层渐进式记忆金字塔架构，自动完成记忆写入、分层提炼、按需召回与注入，让 Agent 从“只能聊天对话”进化为“持续学习、更懂你、跨会话不断线的长期可依赖 AI 助理”。

## 评测

基于 [PersonaMem](https://github.com/jiani-huang/PersonaMem)（UPenn，COLM 2025）评测集，589 道题，20 个角色。

| 题型         | OpenClaw 原生记忆 | TencentDB Agent Memory |
| :----------- | :---------------: | :---------: |
| 召回更新原因 |      70.97%       | **88.89%**  |
| 偏好演变跟踪 |      66.67%       | **83.45%**  |
| 个性化推荐   |      46.67%       | **76.36%**  |
| 场景泛化     |      31.58%       | **78.95%**  |
| 召回用户事实 |      29.63%       | **79.07%**  |
| 召回事实     |      25.00%       | **76.47%**  |
| 创意建议     |      24.00%       | **45.16%**  |
| **总计**     |    **47.85%**     | **76.10%**  |

## 主要特点

- **OpenClaw 原生插件**，包名 `@tencentdb-agent-memory/memory-tencentdb`，一行命令即可安装
- **四层记忆链路**：L0 原始对话 → L1 结构化记忆 → L2 场景归纳 → L3 用户画像
- **混合召回**：支持 `keyword`、`embedding`、`hybrid` 三种策略
- **两类检索工具**：`tdai_memory_search`（查结构化记忆）和 `tdai_conversation_search`（查原始对话）
- **本地优先存储**：JSONL + SQLite，数据在本地可直接查看和排查
- **工程化能力**：去重、checkpoint、备份、定时清理、指标日志
- **MIT 许可证**

## 快速开始

### 环境要求

- Node.js `>= 22.16.0`
- OpenClaw `>= 2026.3.13`

### 安装

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
```

安装完成后，插件接入 OpenClaw 对话生命周期，自动执行对话捕获、记忆召回和 L1/L2/L3 后续处理。

### 从源码开发

本项目无需编译。Node.js 22.16+ 原生支持 TypeScript 类型剥离，OpenClaw 直接加载 `.ts` 源码运行。

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory
npm install
openclaw plugins install --link .
```

`install --link` 会将当前目录作为本地插件注册到 OpenClaw，修改源码后重启 Gateway 即可生效。

### 可选：开启 embedding 召回

如果需要向量检索或混合召回，补充 embedding 配置即可。当前支持兼容 OpenAI API 的远程 embedding 服务。

```jsonc
{
  "plugins": {
    "entries": {
      "memory-tencentdb": {
        "enabled": true,
        "config": {
          "embedding": { // 需配置自定义Embedding模型信息，非LLM模型
            "enabled": true, // 是否启用向量搜索
            "provider": "openai", // 暂只支持OpenAI兼容的协议
            "baseUrl": "https://xxx", // API Base URL
            "apiKey": "xxx", // API Key
            "model": "text-embedding-3-large", // 模型名称
            "dimensions": 1024 // 向量维度（需与所选模型匹配）
          }
        }
      }
    }
  }
}

```


## 架构

```text
        ┌─────────────────┐
        │  L3 用户画像     │  偏好与行为模式
        ├─────────────────┤
        │  L2 场景归纳     │  跨会话的任务 / 场景块
        ├─────────────────┤
        │  L1 结构化记忆   │  事实、约束、偏好、决策
        ├─────────────────┤
        │  L0 原始对话     │  完整对话记录
        └─────────────────┘
```

各层各有侧重：

- **L0** 保留原始对话，用于回溯和精确检索
- **L1** 抽取高价值信息，直接用于召回
- **L2** 将零散记忆整理成场景块，跨会话聚合
- **L3** 维护用户画像，用于长期偏好建模

## 生命周期

| 阶段 | 触发时机 | 动作 |
|---|---|---|
| Recall | `before_prompt_build` | 召回相关记忆，注入上下文 |
| L0 | `agent_end` | 写入原始对话 |
| L1 | 调度触发 | 提取结构化记忆，去重，持久化 |
| L2 | L1 完成后 | 更新场景块 |
| L3 | 达到阈值 | 生成或刷新用户画像 |
| Shutdown | `gateway_stop` | 清理资源 |

插件还注册了两个 tool 供 Agent 主动调用：

- `tdai_memory_search`：查 L1 结构化记忆。适合"用户偏好什么""之前确认过哪些约束"类问题。
- `tdai_conversation_search`：查 L0 原始对话。适合需要原始措辞的场景。

## 检索实现

三种召回策略：

| 策略 | 实现 |
|---|---|
| `keyword` | FTS5 全文检索，中文分词基于 jieba |
| `embedding` | sqlite-vec 向量相似度检索 |
| `hybrid` | 融合关键词与向量结果 |

底层存储统一用 SQLite。

## 配置

按能力分组：

| 配置组 | 作用 |
|---|---|
| `capture` | L0 对话捕获、排除规则、保留时间 |
| `extraction` | L1 提取、去重、单次上限 |
| `persona` | L2/L3 触发频率、场景上限、备份数量 |
| `pipeline` | L1/L2/L3 调度节奏 |
| `recall` | 自动召回开关、结果数、阈值、策略 |
| `embedding` | 向量检索服务配置 |
| `report` | 指标日志 |

最小配置只需要安装插件。如果需要更好的召回效果，再加 `embedding` 和调度参数。

## 数据目录

```text
<pluginDataDir>/
├── conversations/   # L0 原始对话
├── records/         # L1 结构化记忆
├── scene_blocks/    # L2 场景块
├── .metadata/       # checkpoint、索引、元数据
└── .backup/         # 备份
```

## 仓库范围

当前仓库是 OpenClaw 插件的核心实现。

**包含**：插件入口与生命周期钩子、四层记忆链路、检索工具与自动召回、JSONL + SQLite 本地存储、checkpoint / 备份 / 清理 / 日志。

### 代码结构

```text
TencentDB-Agent-Memory/
├── index.ts                  # 插件注册、工具注册、生命周期接入
├── openclaw.plugin.json
├── package.json
├── CHANGELOG.md
└── src/
    ├── hooks/                # 自动召回与自动捕获
    ├── conversation/         # L0 对话管理
    ├── record/               # L1 提取与持久化
    ├── scene/                # L2 场景归纳
    ├── persona/              # L3 用户画像
    ├── store/                # SQLite / FTS / 向量检索
    ├── tools/                # 检索工具注册
    ├── prompts/              # prompt 模板
    ├── report/               # 指标上报
    └── utils/
```

## 许可证

MIT。详见 [LICENSE](LICENSE)。