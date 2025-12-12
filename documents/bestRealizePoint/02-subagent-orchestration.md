# SubAgent 编排最佳实践报告

> 基于 CrewAI、AutoGen、LangGraph 的深度分析

---

## 1. 核心概念

### 什么是 SubAgent

SubAgent 是在多 Agent 系统中执行特定子任务的**独立 Agent 实例**。

| 特征 | 说明 |
|------|------|
| **隔离性** | 独立的消息历史、工具集、系统提示 |
| **专业性** | 针对特定任务定制（研究、编码、审查等）|
| **递归性** | 通过主 Agent 的工具调用创建 |
| **临时性** | 任务完成后销毁 |

### 为什么需要 SubAgent

```
主 Agent（通才）
    ├── 复杂任务分解
    ├── 调用 SubAgent（专家）
    │   ├── Researcher: 信息收集
    │   ├── Coder: 代码实现
    │   └── Reviewer: 代码审查
    └── 整合结果
```

**优势**：
- 专业化分工
- 隔离上下文避免污染
- 并行执行提高效率
- 灵活使用不同模型（小任务用便宜模型）

---

## 2. 行业实现对比

### 2.1 CrewAI

```python
from crewai import Agent, Task, Crew, Process

# 定义 Agent（角色）
researcher = Agent(
    role='Senior Researcher',
    goal='Uncover cutting-edge developments in AI',
    backstory='Expert researcher with deep knowledge...',
    tools=[search_tool, wiki_tool],
    llm='gpt-4'
)

coder = Agent(
    role='Senior Developer',
    goal='Write clean, efficient code',
    backstory='10+ years of Python experience...',
    tools=[code_exec_tool],
    llm='gpt-4'
)

# 定义任务
research_task = Task(
    description='Research the latest AI trends',
    expected_output='Comprehensive report',
    agent=researcher
)

code_task = Task(
    description='Implement the solution',
    expected_output='Working Python code',
    agent=coder
)

# 创建 Crew（编排）
crew = Crew(
    agents=[researcher, coder],
    tasks=[research_task, code_task],
    process=Process.sequential  # 或 Process.hierarchical
)

result = crew.kickoff()
```

**CrewAI 特点**：
- 角色驱动（role, goal, backstory）
- 三种执行模式：sequential, hierarchical, parallel
- 内置记忆系统（短期、长期、实体记忆）
- 支持人类反馈循环

### 2.2 AutoGen

```python
from autogen import AssistantAgent, UserProxyAgent

# 创建 Agent
assistant = AssistantAgent(
    name="Assistant",
    llm_config={"model": "gpt-4"},
    system_message="You are a helpful AI assistant."
)

user_proxy = UserProxyAgent(
    name="User",
    human_input_mode="NEVER",
    code_execution_config={"work_dir": "workspace"}
)

# 对话式编排
user_proxy.initiate_chat(
    assistant,
    message="Write a Python function to calculate fibonacci"
)
```

**AutoGen 特点**：
- 对话驱动（Agent 之间通过消息交流）
- 支持群聊（GroupChat）
- 灵活的人类介入模式
- 代码执行隔离

### 2.3 LangGraph

```python
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import create_react_agent

# 定义状态
class AgentState(TypedDict):
    messages: list
    current_agent: str

# 创建专业 Agent
researcher = create_react_agent(model, [search_tool])
coder = create_react_agent(model, [python_repl])

# 构建图
graph = StateGraph(AgentState)

graph.add_node("supervisor", supervisor_node)
graph.add_node("researcher", researcher)
graph.add_node("coder", coder)

# 定义边（路由逻辑）
graph.add_conditional_edges(
    "supervisor",
    route_to_agent,
    {
        "researcher": "researcher",
        "coder": "coder",
        "FINISH": END
    }
)

graph.add_edge("researcher", "supervisor")
graph.add_edge("coder", "supervisor")

chain = graph.compile()
```

**LangGraph 特点**：
- 图驱动（节点 + 边）
- 显式状态管理
- 支持循环和条件分支
- 可视化工作流

---

## 3. 编排模式

### 3.1 Supervisor 模式（推荐）

```
┌─────────────────────────────────────────┐
│              Supervisor                  │
│         (任务分解 + 结果整合)             │
└────────────┬────────────────────────────┘
             │
     ┌───────┼───────┬───────┐
     ▼       ▼       ▼       ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│Researcher│ │ Coder  │ │Reviewer│
└─────────┘ └─────────┘ └─────────┘
```

**适用场景**：复杂任务需要多专家协作

### 3.2 Sequential 模式

```
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Agent A  │ -> │ Agent B  │ -> │ Agent C  │
│ (研究)   │    │ (实现)   │    │ (审查)   │
└──────────┘    └──────────┘    └──────────┘
```

**适用场景**：流水线式任务，每步依赖前一步输出

### 3.3 Parallel 模式

```
          ┌──────────┐
     ┌──> │ Agent A  │ ──┐
     │    └──────────┘   │
     │    ┌──────────┐   │
Start├──> │ Agent B  │ ──┼──> Aggregate
     │    └──────────┘   │
     │    ┌──────────┐   │
     └──> │ Agent C  │ ──┘
          └──────────┘
```

**适用场景**：独立任务可并行执行

### 3.4 Hierarchical 模式

```
         ┌───────────────┐
         │    Manager    │
         └───────┬───────┘
     ┌───────────┼───────────┐
     ▼           ▼           ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│Team Lead│ │Team Lead│ │Team Lead│
└────┬────┘ └────┬────┘ └────┬────┘
     │           │           │
┌────┴────┐ ┌────┴────┐ ┌────┴────┐
│ Workers │ │ Workers │ │ Workers │
└─────────┘ └─────────┘ └─────────┘
```

**适用场景**：大规模任务，多层级管理

---

## 4. Sakura 推荐实现

### 4.1 设计原则

1. **简单优先**：Claude Code 风格，单主循环 + SubAgent 工具
2. **配置驱动**：Markdown 文件定义 SubAgent
3. **隔离执行**：每个 SubAgent 独立消息历史
4. **复用现有架构**：使用 Sakura 的 Agent 类

### 4.2 SubAgent 配置格式

```markdown
<!-- subagents/researcher.md -->
---
name: researcher
description: 专业研究员，擅长信息收集和分析
model: qwen-plus
tools: search_web, read_file, summarize
max_tokens: 4096
temperature: 0.7
---

# 角色定义

你是一位资深研究员，具有以下特点：
- 10年以上行业研究经验
- 擅长信息检索和综合分析
- 注重信息来源的可靠性

# 工作原则

1. 始终验证信息来源
2. 多角度分析问题
3. 用数据支持结论
4. 承认不确定性

# 输出格式

## 研究摘要
[核心发现]

## 详细分析
[分段分析]

## 信息来源
- [来源列表]

## 局限性
[研究局限说明]
```

### 4.3 配置解析器

```python
from pathlib import Path
from dataclasses import dataclass
from typing import List, Optional
import yaml
import re

@dataclass
class SubAgentConfig:
    """SubAgent 配置"""
    name: str
    description: str
    model: str
    tools: List[str]
    system_prompt: str
    max_tokens: int = 4096
    temperature: float = 0.7
    timeout: float = 60.0
    
    @classmethod
    def from_markdown(cls, path: str) -> "SubAgentConfig":
        """从 Markdown 文件加载配置"""
        content = Path(path).read_text(encoding='utf-8')
        
        # 解析 YAML frontmatter
        frontmatter_match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
        if frontmatter_match:
            frontmatter = yaml.safe_load(frontmatter_match.group(1))
            body = content[frontmatter_match.end():].strip()
        else:
            frontmatter = {}
            body = content
        
        # 解析 tools（逗号分隔字符串 → 列表）
        tools_str = frontmatter.get("tools", "")
        tools = [t.strip() for t in tools_str.split(",") if t.strip()]
        
        return cls(
            name=frontmatter.get("name", Path(path).stem),
            description=frontmatter.get("description", ""),
            model=frontmatter.get("model", "qwen-plus"),
            tools=tools,
            system_prompt=body,
            max_tokens=frontmatter.get("max_tokens", 4096),
            temperature=frontmatter.get("temperature", 0.7),
            timeout=frontmatter.get("timeout", 60.0)
        )


class SubAgentConfigLoader:
    """配置加载器（带缓存）"""
    
    _cache: dict[str, SubAgentConfig] = {}
    _search_paths: List[Path] = [
        Path("./subagents"),
        Path(__file__).parent / "subagents"  # 内置配置
    ]
    
    @classmethod
    def load(cls, config_name: str) -> Optional[SubAgentConfig]:
        """加载配置（优先使用缓存）"""
        if config_name in cls._cache:
            return cls._cache[config_name]
        
        # 搜索配置文件
        for base_path in cls._search_paths:
            config_path = base_path / f"{config_name}.md"
            if config_path.exists():
                config = SubAgentConfig.from_markdown(str(config_path))
                cls._cache[config_name] = config
                return config
        
        return None
    
    @classmethod
    def clear_cache(cls):
        cls._cache.clear()
```

### 4.4 SubAgent 工具实现

```python
from sakura import Agent
from sakura.tools import get_tool
from sakura.tools.function import Function

_config_loader = SubAgentConfigLoader()

@tool
def subagent(
    prompt: str,
    config: str = "general-purpose",
    context: str = ""
) -> str:
    """
    创建子 Agent 执行专门任务。
    
    SubAgent 是具有特定专业能力的独立 Agent，可以处理需要专业知识的任务。
    
    可用配置：
    - researcher: 信息研究和分析
    - coder: 代码编写和调试
    - reviewer: 代码审查和优化建议
    - writer: 文档和内容创作
    - general-purpose: 通用助手
    
    Args:
        prompt: 交给 SubAgent 的任务描述
        config: SubAgent 配置名称（不含 .md 后缀）
        context: 额外上下文信息
    
    Returns:
        SubAgent 的执行结果
    
    Examples:
        subagent("研究 Python asyncio 的最佳实践", config="researcher")
        subagent("实现一个 LRU 缓存类", config="coder")
    """
    # 加载配置
    cfg = _config_loader.load(config)
    if not cfg:
        return f"Error: SubAgent config '{config}' not found. Available: researcher, coder, reviewer, writer, general-purpose"
    
    # 解析工具
    tools = []
    for tool_name in cfg.tools:
        t = get_tool(tool_name)
        if t:
            tools.append(t)
    
    # 构建完整提示
    full_prompt = prompt
    if context:
        full_prompt = f"背景信息:\n{context}\n\n任务:\n{prompt}"
    
    # 创建 SubAgent
    sub = Agent(
        model=cfg.model,
        tools=tools,
        system_prompt=cfg.system_prompt,
        max_tool_calls=10
    )
    
    try:
        result = sub.run(full_prompt)
        return f"[{cfg.name}] 完成\n\n{result.content or '(无输出)'}"
    except Exception as e:
        return f"[{cfg.name}] 错误: {str(e)}"
```

### 4.5 并行 SubAgent 执行

```python
import asyncio
from typing import List, Dict

@tool
async def parallel_subagents(
    tasks: List[Dict[str, str]]
) -> str:
    """
    并行执行多个 SubAgent 任务。
    
    当有多个独立任务需要同时处理时使用此工具。
    
    Args:
        tasks: 任务列表，每个任务包含:
            - prompt: 任务描述
            - config: SubAgent 配置名称
            - context: (可选) 额外上下文
    
    Returns:
        所有 SubAgent 的执行结果
    
    Example:
        parallel_subagents([
            {"prompt": "研究 Redis 缓存策略", "config": "researcher"},
            {"prompt": "研究 Memcached 特点", "config": "researcher"},
            {"prompt": "对比两者优劣", "config": "reviewer"}
        ])
    """
    async def run_one(task: Dict[str, str]) -> str:
        cfg = _config_loader.load(task.get("config", "general-purpose"))
        if not cfg:
            return f"Error: config not found"
        
        tools = [get_tool(t) for t in cfg.tools if get_tool(t)]
        
        sub = Agent(
            model=cfg.model,
            tools=tools,
            system_prompt=cfg.system_prompt
        )
        
        prompt = task.get("prompt", "")
        if task.get("context"):
            prompt = f"背景:\n{task['context']}\n\n任务:\n{prompt}"
        
        try:
            result = await sub.arun(prompt)
            return f"### [{cfg.name}] {task.get('prompt', '')[:30]}...\n\n{result.content}"
        except Exception as e:
            return f"### [{cfg.name}] 错误\n\n{str(e)}"
    
    # 并行执行
    results = await asyncio.gather(
        *[run_one(t) for t in tasks],
        return_exceptions=True
    )
    
    # 格式化输出
    output = ["# 并行 SubAgent 执行结果\n"]
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            output.append(f"### Task {i+1} 错误\n\n{str(result)}")
        else:
            output.append(str(result))
    
    return "\n\n---\n\n".join(output)
```

---

## 5. 内置 SubAgent 配置

### 5.1 researcher.md

```markdown
---
name: researcher
description: 专业研究员，擅长信息收集和综合分析
model: qwen-plus
tools: search_web, read_file
temperature: 0.7
---

# 角色

你是资深研究员，专注于：
- 信息检索和验证
- 多源数据综合
- 结构化报告输出

# 输出格式

## 核心发现
[1-3 个关键点]

## 详细分析
[结构化分析]

## 来源
[引用列表]
```

### 5.2 coder.md

```markdown
---
name: coder
description: 资深开发者，擅长代码实现和优化
model: qwen-plus
tools: read_file, write_file, python_exec
temperature: 0.5
---

# 角色

你是资深开发者，遵循：
- 简洁清晰的代码风格
- 完善的错误处理
- 适当的注释和文档

# 工作流程

1. 理解需求
2. 设计方案
3. 实现代码
4. 验证测试
```

### 5.3 reviewer.md

```markdown
---
name: reviewer
description: 代码审查专家，关注质量和最佳实践
model: qwen-plus
tools: read_file
temperature: 0.6
---

# 角色

你是代码审查专家，关注：
- 代码质量和可维护性
- 潜在 Bug 和安全问题
- 性能优化机会
- 最佳实践遵循

# 输出格式

## 总体评价
[优/良/中/差 + 简评]

## 问题列表
- [严重程度] 问题描述 + 建议

## 优化建议
[可选的改进方向]
```

---

## 6. 使用模式

### 模式 1：单 SubAgent 调用

```python
# Agent 内部调用
subagent("研究 Python 3.12 的新特性", config="researcher")
```

### 模式 2：链式调用

```python
# 研究 → 实现 → 审查
research = subagent("研究 LRU 缓存算法", config="researcher")
code = subagent(f"基于以下研究实现 LRU 缓存:\n{research}", config="coder")
review = subagent(f"审查以下代码:\n{code}", config="reviewer")
```

### 模式 3：并行调用

```python
# 多专家同时工作
parallel_subagents([
    {"prompt": "分析 Redis", "config": "researcher"},
    {"prompt": "分析 Memcached", "config": "researcher"},
    {"prompt": "分析 Hazelcast", "config": "researcher"}
])
```

---

## 7. 与 Task Tool 的配合

```python
# 典型工作流
task(action="add", description="研究缓存方案")
task(action="add", description="实现缓存模块")
task(action="add", description="代码审查")
task(action="add", description="完善文档")

# 执行第一步
task(action="update", task_id="t1", status="in_progress")
research_result = subagent("研究分布式缓存最佳实践", config="researcher")
task(action="update", task_id="t1", status="completed")

# 执行第二步
task(action="update", task_id="t2", status="in_progress")
code_result = subagent(f"实现缓存模块，参考:\n{research_result}", config="coder")
task(action="update", task_id="t2", status="completed")

# ...
```

---

## 8. 性能与成本优化

| 策略 | 说明 |
|------|------|
| **模型分层** | 简单任务用 qwen-turbo，复杂任务用 qwen-plus |
| **配置缓存** | Markdown 解析一次，多次复用 |
| **并行执行** | 独立任务用 parallel_subagents |
| **超时控制** | 防止单个 SubAgent 阻塞过久 |
| **结果缓存** | 相同任务可缓存结果（可选）|
