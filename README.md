# Sakura Agent Framework

> **核心哲学**：不重新发明轮子，让好的东西更好。
> 
> **框架定位**：只做好一件事情 —— 让 LLM Agent 开发更简单、更高效。

## 🎯 设计理念

Sakura 是一个**轻量级、高性能**的 Agent 框架，专注于：

1. **极简 API** - 5 分钟上手，无学习曲线
2. **多模型支持** - 统一接口，一键切换 Qwen/OpenAI/Claude/Kimi
3. **工程化工具** - 可观测、可追踪、可调试
4. **生产就绪** - 经过优化的性能，适合部署

## 🚀 快速开始

### 安装

```bash
pip install sakuragent

# 可选依赖
pip install sakuragent[qwen]    # 阿里云通义千问
pip install sakuragent[claude]  # Anthropic Claude
pip install sakuragent[search]  # 搜索工具
pip install sakuragent[all]     # 全部安装
```

### 最简示例

```python
from sakura import Agent, tool
from sakura.models import Qwen

@tool
def search(query: str) -> str:
    """搜索网络"""
    return f"搜索结果: {query}"

agent = Agent(
    model=Qwen(id="qwen-plus"),
    tools=[search],
    system_prompt="你是一个有帮助的助手"
)

result = agent.run("搜索 Python 最佳实践")
print(result.content)
```

### 异步执行（真正的并行工具调用）

```python
import asyncio

# 异步执行，工具调用并行
result = await agent.arun("同时搜索三个主题")
```

## 🏗️ 核心模块

### 1. Agent - 统一的代理类

```python
from sakura import Agent

agent = Agent(
    model=Qwen(id="qwen-plus"),     # 模型
    tools=[tool1, tool2],            # 工具列表
    system_prompt="...",             # 系统提示词
    max_tool_calls=10,               # 最大工具调用次数
    debug=True,                      # 调试模式
)

# 同步执行
result = agent.run("你的问题")

# 异步执行（并行工具调用）
result = await agent.arun("你的问题")
```

### 2. Models - 多模型支持

```python
from sakura.models import Qwen, OpenAI, Claude, Kimi, OpenRouter

# 阿里云通义千问
model = Qwen(id="qwen-plus")  # 或 qwen-turbo, qwen-max

# OpenAI
model = OpenAI(id="gpt-4o")

# Anthropic Claude
model = Claude(id="claude-sonnet-4-20250514")

# 月之暗面 Kimi
model = Kimi(id="moonshot-v1-8k")

# OpenRouter (访问多种模型)
model = OpenRouter(id="anthropic/claude-3.5-sonnet")
```

所有模型使用统一 API，切换只需改一行代码。

### 3. Tools - 工具系统

#### 自定义工具

```python
from sakura import tool

@tool
def calculate(expression: str) -> str:
    """计算数学表达式
    
    Args:
        expression: 数学表达式，如 "1+2*3"
    
    Returns:
        计算结果
    """
    return str(eval(expression))
```

#### 内置工具

```python
from sakura.tools.builtin import DuckDuckGoTools, BaiduSearchTools, FileTools

# 搜索工具
ddg = DuckDuckGoTools()
baidu = BaiduSearchTools()

agent = Agent(
    model=...,
    tools=[ddg.duckduckgo_search, baidu.baidu_search]
)
```

### 4. SubAgent - 子代理系统

创建专门的子 Agent 处理特定任务：

```python
from sakura.tools.subagent import subagent, parallel_subagents

# 单个 SubAgent
result = subagent(
    prompt="研究 Python 异步编程",
    model="qwen-plus",
    tools=[search_tool],
    system_prompt="你是技术研究员"
)

# 并行多个 SubAgent
results = await parallel_subagents(
    prompts=["研究主题A", "研究主题B", "研究主题C"],
    model="qwen-plus",
    tools=[search_tool]
)
```

### 5. Monitor - 可观测性

#### 计时装饰器

```python
from sakura.monitor import timer

@timer
def my_function():
    # 自动打印执行时间
    ...
```

#### 数据库监控

```python
from sakura.monitor import Monitor, monitor

# 创建监控器（支持 SQLite/PostgreSQL/MySQL）
mon = Monitor("./agent_logs.db")

@monitor(storage=mon.storage)
def agent_task(prompt):
    return agent.run(prompt)

# 查看统计
print(mon.get_stats())
```

#### 🆕 执行流程追踪（Mermaid 流程图）

```python
from sakura.monitor import trace_flow, trace_span, FlowTracer

@trace_flow(output_file="trace.html")
async def research(topic: str):
    with trace_span("主 Agent", span_type="agent", model="qwen-plus"):
        result = await agent.arun(topic)
    return result

# 终端输出 Mermaid 代码
# HTML 文件包含可点击的流程图，显示:
# - 模型、工具、系统提示词
# - 执行时间、Token 统计
# - 调用层级关系
```

生成的 HTML 效果：
- 📊 可视化流程图
- 🖱️ 点击节点查看详情（模型/工具/提示词）
- ⏱️ 每个步骤的耗时统计

### 6. Memory - 智能记忆

```python
from sakura import SmartCompressor

agent = Agent(
    model=...,
    memory=SmartCompressor(
        threshold=0.92,     # 92% 上下文时触发压缩
        strategy="structured"
    )
)
```

## 📊 实用示例

### 深度研究 Agent

```python
from sakura import Agent, tool
from sakura.models import Qwen
from sakura.tools.builtin import BaiduSearchTools
from sakura.monitor import trace_flow, trace_span

baidu = BaiduSearchTools()

@tool
def web_search(query: str) -> str:
    """搜索网络获取信息"""
    return baidu.baidu_search(query, max_results=5)

@trace_flow(output_file="research_trace.html")
async def deep_research(topic: str):
    agent = Agent(
        model=Qwen(id="qwen-plus"),
        tools=[web_search],
        system_prompt="""你是一个研究员，请：
1. 搜索相关信息
2. 综合分析
3. 输出结构化报告""",
        debug=True
    )
    
    with trace_span("研究任务", span_type="agent", 
                    model="qwen-plus", 
                    user_prompt=topic):
        result = await agent.arun(topic)
    
    return result

# 运行
import asyncio
result = asyncio.run(deep_research("Python 3.12 新特性"))
```

### 多 Agent 协作

```python
from sakura.tools.subagent import parallel_subagents

async def multi_agent_research(topic: str):
    # 并行启动多个专家 Agent
    focuses = ["基础概念", "最新进展", "实际应用"]
    
    results = await parallel_subagents(
        prompts=[f"研究 {topic} 的{focus}" for focus in focuses],
        model="qwen-plus",
        tools=[web_search],
        system_prompt="你是专业研究员"
    )
    
    # 汇总结果
    final_agent = Agent(model=Qwen(id="qwen-plus"))
    summary = final_agent.run(f"综合以下研究报告：{results}")
    
    return summary
```

## 🔧 环境变量

```bash
# 阿里云通义千问
export DASHSCOPE_API_KEY="your-key"

# OpenAI
export OPENAI_API_KEY="your-key"

# Anthropic Claude  
export ANTHROPIC_API_KEY="your-key"

# 月之暗面 Kimi
export MOONSHOT_API_KEY="your-key"

# OpenRouter
export OPENROUTER_API_KEY="your-key"
```

## 📁 项目结构

```
sakura/
├── __init__.py          # 主入口
├── agent.py             # Agent 核心类
├── models/              # 模型适配器
│   ├── qwen.py
│   ├── openai.py
│   ├── claude.py
│   └── ...
├── tools/               # 工具系统
│   ├── decorator.py     # @tool 装饰器
│   ├── builtin/         # 内置工具
│   └── subagent/        # 子 Agent
├── monitor/             # 可观测性
│   ├── decorators.py    # @timer, @monitor
│   ├── storage.py       # 数据库存储
│   └── tracer.py        # 流程追踪 (NEW)
├── memory/              # 记忆系统
│   └── compressor.py    # 智能压缩
└── messages/            # 消息处理
```

## 🆕 v0.2.0 更新

- ✅ **执行流程追踪** - `@trace_flow` 装饰器，生成 Mermaid 流程图
- ✅ **HTML 可视化** - 点击节点查看 Agent 详情
- ✅ **百度搜索工具** - `BaiduSearchTools` 内置支持
- ✅ **并行 SubAgent** - `parallel_subagents` 真正并行执行
- ✅ **调试模式增强** - `set_log_level_to_debug()` 详细日志

## 💡 设计哲学

### 不重新发明轮子

- 基于成熟的 OpenAI SDK 接口规范
- 使用标准的 Python typing 和 dataclass
- 兼容主流 LLM 服务商 API

### 让好的东西更好

- 统一多模型接口，降低切换成本
- 内置可观测性，无需额外配置
- 流程追踪可视化，调试更直观

### 只做好一件事情

- 专注于 Agent 核心能力
- 不做 RAG、不做向量库、不做 UI
- 轻量级依赖，快速启动

---

**GitHub**: [Vist233/sakura](https://github.com/Vist233/sakura)
**PyPI**: `pip install sakuragent`
**版本**: 0.2.0

**Based on Agno**

