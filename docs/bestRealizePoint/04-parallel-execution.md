# 并行工具执行最佳实践报告

> ✅ **实现状态：已完成** | 代码位置：`sakura/tools/parallel.py`

> 基于 OpenAI Agents SDK、LangGraph、Sakura 现有实现的深度分析

---

## 0. Sakura 实现总结

### 已实现功能

| 功能 | 状态 | 说明 |
|------|------|------|
| 异步并行执行 | ✅ | `execute_tools_parallel()` |
| 工具级配置 | ✅ | `@tool(parallel_safe=True, timeout=30)` |
| 并发限制 | ✅ | `max_parallel_workers` 参数 |
| 超时控制 | ✅ | 单工具超时 + 总超时 |
| 执行指标 | ✅ | `ParallelExecutionMetrics` |

### 使用示例

```python
from sakura import Agent
from sakura.tools import tool

@tool(parallel_safe=True, timeout=10.0)
def search_a(query: str) -> str:
    """搜索 A 源"""
    return requests.get(f"https://a.com/?q={query}").text

@tool(parallel_safe=True, timeout=10.0)
def search_b(query: str) -> str:
    """搜索 B 源"""
    return requests.get(f"https://b.com/?q={query}").text

agent = Agent(
    model="qwen-plus",
    tools=[search_a, search_b],
    parallel_tools=True,       # 启用并行
    max_parallel_workers=5,    # 最大并发数
    parallel_timeout=30.0      # 总超时
)

# LLM 同时调用 search_a 和 search_b 时，会并行执行
result = agent.run("同时搜索 A 和 B 源的信息")
```

---

## 1. 核心价值

### 为什么需要并行执行

```
顺序执行：
Tool A (2s) → Tool B (3s) → Tool C (2s) = 总计 7s

并行执行：
Tool A (2s) ─┐
Tool B (3s) ─┼─→ 总计 3s (取最长)
Tool C (2s) ─┘
```

**收益**：
- 延迟减少 50-80%
- 用户体验提升
- 充分利用 I/O 等待时间

### 适用场景

| 场景 | 示例 |
|------|------|
| **多源搜索** | 同时搜索多个知识库 |
| **API 聚合** | 同时调用多个外部服务 |
| **文件处理** | 同时读取多个文件 |
| **SubAgent 并行** | 多专家同时工作 |

---

## 2. 行业实现对比

### 2.1 OpenAI Assistants API

OpenAI 原生支持并行函数调用：

```python
# 模型返回多个工具调用
run = client.beta.threads.runs.retrieve(thread_id, run_id)

if run.status == "requires_action":
    tool_calls = run.required_action.submit_tool_outputs.tool_calls
    
    # 并行执行
    async def execute_all():
        results = await asyncio.gather(*[
            execute_tool(tc.function.name, tc.function.arguments)
            for tc in tool_calls
        ])
        return results
    
    tool_outputs = asyncio.run(execute_all())
    
    # 提交结果
    client.beta.threads.runs.submit_tool_outputs(
        thread_id=thread_id,
        run_id=run_id,
        tool_outputs=[
            {"tool_call_id": tc.id, "output": result}
            for tc, result in zip(tool_calls, tool_outputs)
        ]
    )
```

### 2.2 OpenAI Agents SDK

```python
from agents import Agent, Runner
import asyncio

# 方式 1：asyncio.gather（确定性并行）
async def run_parallel_agents():
    agent_a = Agent(name="A", ...)
    agent_b = Agent(name="B", ...)
    
    results = await asyncio.gather(
        Runner.run(agent_a, "Task A"),
        Runner.run(agent_b, "Task B"),
        return_exceptions=True
    )
    return results

# 方式 2：Agent as Tool（动态并行）
agent_tool = agent.as_tool(
    tool_name="specialist",
    tool_description="Specialist for specific tasks"
)
meta_agent = Agent(tools=[agent_tool, ...])
```

### 2.3 LangGraph

```python
from langgraph.graph import StateGraph

graph = StateGraph(State)

# 添加并行节点
graph.add_node("search_a", search_a_node)
graph.add_node("search_b", search_b_node)
graph.add_node("search_c", search_c_node)
graph.add_node("aggregate", aggregate_node)

# Fan-out: 从 start 到多个节点
graph.add_edge("start", "search_a")
graph.add_edge("start", "search_b")
graph.add_edge("start", "search_c")

# Fan-in: 从多个节点到聚合
graph.add_edge("search_a", "aggregate")
graph.add_edge("search_b", "aggregate")
graph.add_edge("search_c", "aggregate")
```

### 2.4 Google ADK

```python
# Google Agent Development Kit 1.10+
# 自动检测并行工具调用

class MyAgent:
    @tool(parallel_enabled=True)  # 启用并行
    async def search(self, query: str) -> str:
        return await async_search(query)
```

---

## 3. Sakura 现有实现分析

### 3.1 已实现：异步并行

Sakura 的 `models/base.py` 中已实现异步并行执行：

```python
# base.py L2149-2151
results = await asyncio.gather(
    *(self.arun_function_call(fc) for fc in function_calls_to_run),
    return_exceptions=True
)
```

**特点**：
- ✅ 使用 `asyncio.gather` 并行执行
- ✅ `return_exceptions=True` 错误隔离
- ✅ 支持异步生成器
- ✅ 自动跳过需要确认的工具

### 3.2 未实现：同步并行

同步的 `run_function_calls` 是顺序执行：

```python
# base.py L1871-1971
def run_function_calls(self, function_calls, ...):
    for fc in function_calls:
        yield from self.run_function_call(fc, ...)  # 顺序执行
```

---

## 4. 增强方案

### 4.1 同步场景的并行执行

使用 `concurrent.futures.ThreadPoolExecutor` 实现同步场景的并行：

```python
import concurrent.futures
from typing import List, Iterator

def run_function_calls_parallel(
    self,
    function_calls: List[FunctionCall],
    function_call_results: List[Message],
    max_workers: int = 5,
    **kwargs
) -> Iterator[ModelResponse]:
    """并行执行多个工具调用（同步版本）"""
    
    if len(function_calls) <= 1:
        # 单个工具，直接执行
        yield from self.run_function_call(function_calls[0], function_call_results, ...)
        return
    
    # 分离需要确认的工具
    parallel_calls = []
    sequential_calls = []
    
    for fc in function_calls:
        if fc.function.requires_confirmation or fc.function.external_execution:
            sequential_calls.append(fc)
        else:
            parallel_calls.append(fc)
    
    # 并行执行不需要确认的工具
    if parallel_calls:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(self._execute_single_tool, fc): fc
                for fc in parallel_calls
            }
            
            for future in concurrent.futures.as_completed(futures):
                fc = futures[future]
                try:
                    result = future.result()
                    function_call_results.append(result)
                    yield ModelResponse(
                        content=f"{fc.function.name} completed",
                        tool_executions=[...],
                        event=ModelResponseEvent.tool_call_completed.value
                    )
                except Exception as e:
                    yield ModelResponse(
                        content=f"Error in {fc.function.name}: {e}",
                        tool_executions=[...],
                        event=ModelResponseEvent.tool_call_completed.value
                    )
    
    # 顺序执行需要确认的工具
    for fc in sequential_calls:
        yield from self.run_function_call(fc, function_call_results, ...)

def _execute_single_tool(self, fc: FunctionCall) -> Message:
    """执行单个工具并返回结果消息"""
    timer = Timer()
    timer.start()
    
    try:
        result = fc.execute()
        content = str(result.result) if result.result else ""
        return Message(
            role="tool",
            content=content,
            tool_call_id=fc.call_id,
            tool_name=fc.function.name,
        )
    except Exception as e:
        return Message(
            role="tool",
            content=f"Error: {str(e)}",
            tool_call_id=fc.call_id,
            tool_name=fc.function.name,
            tool_call_error=True,
        )
    finally:
        timer.stop()
```

### 4.2 Agent 级别配置

```python
@dataclass
class Agent:
    # ... 现有字段 ...
    
    # 并行执行配置
    parallel_tools: bool = True       # 是否启用并行
    max_parallel_workers: int = 5     # 最大并行数
    parallel_timeout: float = 30.0    # 单工具超时
    
    def run(self, prompt: str, messages: List[Message] = None, **kwargs):
        # 传递配置给模型
        response = self._model.response(
            messages=all_messages,
            tools=tools,
            parallel_tools=self.parallel_tools,
            max_parallel_workers=self.max_parallel_workers,
            **kwargs,
        )
        return response
```

### 4.3 工具级别控制

```python
@tool(parallel_safe=True)  # 标记为并行安全
def search_web(query: str) -> str:
    """搜索网络"""
    pass

@tool(parallel_safe=False)  # 标记为非并行安全（有副作用）
def write_file(path: str, content: str) -> str:
    """写入文件"""
    pass
```

实现：

```python
def tool(
    parallel_safe: bool = True,
    timeout: float = None,
    **kwargs
):
    """工具装饰器"""
    def decorator(func):
        f = Function.from_callable(func, **kwargs)
        f.parallel_safe = parallel_safe
        f.timeout = timeout
        return f
    return decorator
```

---

## 5. asyncio.gather 最佳实践

### 5.1 基本模式

```python
import asyncio

async def execute_tools_parallel(tool_calls: List[ToolCall]) -> List[str]:
    """并行执行多个工具"""
    
    async def execute_one(tc: ToolCall) -> str:
        try:
            return await run_tool_async(tc.name, tc.arguments)
        except Exception as e:
            return f"Error: {str(e)}"
    
    results = await asyncio.gather(
        *[execute_one(tc) for tc in tool_calls],
        return_exceptions=True  # 关键：错误隔离
    )
    
    return results
```

### 5.2 超时控制

```python
async def execute_with_timeout(
    tool_calls: List[ToolCall],
    timeout: float = 30.0
) -> List[str]:
    """带超时的并行执行"""
    
    async def execute_one(tc: ToolCall) -> str:
        try:
            return await asyncio.wait_for(
                run_tool_async(tc.name, tc.arguments),
                timeout=timeout
            )
        except asyncio.TimeoutError:
            return f"Timeout after {timeout}s"
        except Exception as e:
            return f"Error: {str(e)}"
    
    return await asyncio.gather(
        *[execute_one(tc) for tc in tool_calls],
        return_exceptions=True
    )
```

### 5.3 并发限制（速率控制）

```python
async def execute_with_limit(
    tool_calls: List[ToolCall],
    max_concurrent: int = 5
) -> List[str]:
    """限制并发数量"""
    
    semaphore = asyncio.Semaphore(max_concurrent)
    
    async def execute_one(tc: ToolCall) -> str:
        async with semaphore:  # 获取信号量
            return await run_tool_async(tc.name, tc.arguments)
    
    return await asyncio.gather(
        *[execute_one(tc) for tc in tool_calls],
        return_exceptions=True
    )
```

### 5.4 渐进式结果（as_completed）

```python
async def execute_progressive(
    tool_calls: List[ToolCall]
) -> AsyncIterator[Tuple[str, str]]:
    """按完成顺序返回结果"""
    
    tasks = {
        asyncio.create_task(run_tool_async(tc.name, tc.arguments)): tc
        for tc in tool_calls
    }
    
    for coro in asyncio.as_completed(tasks.keys()):
        task = await coro
        tc = tasks[task]
        yield tc.name, task.result()
```

### 5.5 Python 3.11+ TaskGroup

```python
async def execute_with_taskgroup(tool_calls: List[ToolCall]) -> List[str]:
    """使用 TaskGroup（Python 3.11+，更安全）"""
    
    results = []
    
    async with asyncio.TaskGroup() as tg:
        for tc in tool_calls:
            task = tg.create_task(run_tool_async(tc.name, tc.arguments))
            # TaskGroup 会在任何任务失败时取消所有任务
    
    # 如果需要错误隔离，仍然用 gather + return_exceptions
    return results
```

---

## 6. 错误处理策略

### 6.1 错误隔离

```python
async def execute_isolated(tool_calls: List[ToolCall]) -> List[Tuple[str, bool, str]]:
    """错误隔离执行，返回 (结果, 是否成功, 错误信息)"""
    
    async def execute_one(tc: ToolCall) -> Tuple[str, bool, str]:
        try:
            result = await run_tool_async(tc.name, tc.arguments)
            return (result, True, "")
        except Exception as e:
            return ("", False, str(e))
    
    return await asyncio.gather(
        *[execute_one(tc) for tc in tool_calls]
    )
```

### 6.2 重试逻辑

```python
import asyncio
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10)
)
async def run_tool_with_retry(name: str, args: dict) -> str:
    """带重试的工具执行"""
    return await run_tool_async(name, args)
```

### 6.3 降级策略

```python
async def execute_with_fallback(
    tool_calls: List[ToolCall],
    fallback_values: Dict[str, str]
) -> List[str]:
    """带降级的执行"""
    
    async def execute_one(tc: ToolCall) -> str:
        try:
            return await asyncio.wait_for(
                run_tool_async(tc.name, tc.arguments),
                timeout=10.0
            )
        except Exception:
            return fallback_values.get(tc.name, "Tool unavailable")
    
    return await asyncio.gather(*[execute_one(tc) for tc in tool_calls])
```

---

## 7. 性能优化建议

### 7.1 避免常见陷阱

| 陷阱 | 解决方案 |
|------|----------|
| **阻塞事件循环** | 确保所有 I/O 使用 await |
| **过度并发** | 使用 Semaphore 限制 |
| **忽略异常** | 使用 return_exceptions=True |
| **无超时** | 使用 asyncio.wait_for |
| **资源泄露** | 确保清理（async with）|

### 7.2 性能监控

```python
import time
from dataclasses import dataclass, field
from typing import Dict, List

@dataclass
class ParallelExecutionMetrics:
    """并行执行指标"""
    
    total_calls: int = 0
    parallel_calls: int = 0
    sequential_calls: int = 0
    total_latency: float = 0
    parallel_latency: float = 0
    errors: int = 0
    
    tool_latencies: Dict[str, List[float]] = field(default_factory=dict)
    
    def record_execution(
        self,
        tool_name: str,
        latency: float,
        parallel: bool,
        error: bool = False
    ):
        self.total_calls += 1
        self.total_latency += latency
        
        if parallel:
            self.parallel_calls += 1
            self.parallel_latency += latency
        else:
            self.sequential_calls += 1
        
        if error:
            self.errors += 1
        
        if tool_name not in self.tool_latencies:
            self.tool_latencies[tool_name] = []
        self.tool_latencies[tool_name].append(latency)
    
    def report(self) -> str:
        parallel_savings = (
            self.total_latency - self.parallel_latency
        ) if self.parallel_calls > 0 else 0
        
        return f"""
并行执行统计:
- 总调用: {self.total_calls}
- 并行调用: {self.parallel_calls} ({self.parallel_calls/self.total_calls*100:.1f}%)
- 顺序调用: {self.sequential_calls}
- 错误数: {self.errors}
- 预估节省时间: {parallel_savings:.2f}s

工具延迟分布:
{self._tool_latency_report()}
"""
    
    def _tool_latency_report(self) -> str:
        lines = []
        for name, latencies in self.tool_latencies.items():
            avg = sum(latencies) / len(latencies)
            lines.append(f"  - {name}: avg {avg:.2f}s ({len(latencies)} calls)")
        return "\n".join(lines)
```

---

## 8. Sakura 集成方案

### 8.1 最小改动方案

在 `Model.response` 中添加并行配置：

```python
def response(
    self,
    messages: List[Message],
    tools: Optional[List[Function]] = None,
    parallel_tools: bool = True,  # 新增
    max_parallel_workers: int = 5,  # 新增
    **kwargs
) -> ModelResponse:
    # ... 现有逻辑 ...
    
    # 执行工具时使用并行
    if parallel_tools and len(function_calls_to_run) > 1:
        for result in self.run_function_calls_parallel(
            function_calls=function_calls_to_run,
            function_call_results=function_call_results,
            max_workers=max_parallel_workers,
        ):
            # 处理结果
            pass
    else:
        for result in self.run_function_calls(...):
            pass
```

### 8.2 使用示例

```python
from sakura import Agent

# 启用并行（默认）
agent = Agent(
    model="qwen-plus",
    tools=[search_a, search_b, search_c],
    parallel_tools=True,
    max_parallel_workers=5
)

# 禁用并行（有状态依赖时）
agent = Agent(
    model="qwen-plus",
    tools=[step1, step2, step3],
    parallel_tools=False
)

# 异步使用（推荐）
result = await agent.arun("同时搜索三个来源")
```

---

## 9. 总结

### 关键要点

1. **Sakura 异步已实现**：`arun_function_calls` 使用 `asyncio.gather`
2. **同步需增强**：添加 `ThreadPoolExecutor` 支持
3. **错误隔离必须**：使用 `return_exceptions=True`
4. **超时控制重要**：防止单个工具阻塞全局
5. **并发需限制**：避免触发 API 速率限制

### 推荐配置

```python
# 生产环境推荐配置
Agent(
    parallel_tools=True,
    max_parallel_workers=5,
    parallel_timeout=30.0
)
```
