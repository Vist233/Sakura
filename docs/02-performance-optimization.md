# 性能优化指南

本文档详细说明如何将框架开销从 1s 优化到 <0.3s 的具体方案。

## 目录
- [问题分析](#问题分析)
- [快速优化方案](#快速优化方案)
- [架构级优化](#架构级优化)
- [底层优化](#底层优化)
- [性能测试](#性能测试)
- [优化检查清单](#优化检查清单)

## 问题分析

### 性能基准

| 指标 | 数值 | 说明 |
|------|------|------|
| 裸 HTTP 调用 | 0.7s | 直接调用 LLM API |
| agno 框架 | 1.7s | 通过 agno 框架调用 |
| **框架开销** | **1.0s (143%)** | **不可接受！** |

### 1s 开销分布估算

基于 agno 架构分析，1s 开销可能分布如下：

```
总开销: 1000ms
├─ 消息序列化/反序列化: 200-300ms (20-30%)
│  ├─ Pydantic 模型验证
│  ├─ 消息历史重建
│  └─ JSON dumps/loads
│
├─ 工具 schema 生成: 100-200ms (10-20%)
│  ├─ inspect.signature() 反射
│  ├─ Pydantic 转 JSON Schema
│  └─ 文档字符串解析
│
├─ 监控/日志系统: 100-200ms (10-20%)
│  ├─ 数据库写入
│  ├─ 装饰器栈开销
│  └─ Metrics 收集聚合
│
├─ 重试/缓存逻辑: 50-100ms (5-10%)
│  ├─ 缓存检查
│  ├─ 重试装饰器初始化
│  └─ 响应序列化
│
├─ 同步/异步转换: 50-100ms (5-10%)
│  ├─ asyncio.run() 事件循环
│  └─ 协程调度开销
│
└─ 其他开销: 100-200ms (10-20%)
   ├─ Provider 额外封装
   ├─ 中间件/钩子
   └─ 异常处理栈
```

## 快速优化方案

目标：**1-3 天完成，减少 500ms 开销**

### 1. 工具 Schema 预编译

**问题**：每次请求都通过反射生成 schema

**优化前**：
```python
class Agent:
    def run(self, prompt):
        # 每次调用都重新生成 schema！
        tool_schemas = [tool.to_json_schema() for tool in self.tools]
        response = self.model.invoke(messages, tools=tool_schemas)
```

**优化后**：
```python
class FastAgent:
    def __init__(self, tools):
        # 初始化时生成一次，缓存起来
        self._tool_schemas = self._compile_schemas(tools)
        self._tool_map = {t.name: t for t in tools}

    def _compile_schemas(self, tools):
        """只在初始化时调用一次"""
        return [tool.to_json_schema() for tool in tools]

    def run(self, prompt):
        # 直接使用缓存的 schema
        response = self.model.invoke(messages, tools=self._tool_schemas)
```

**预期收益**：减少 100-150ms

### 2. 消息零拷贝

**问题**：每次调用都深拷贝整个消息历史

**优化前**：
```python
def build_messages(self, history, new_msg):
    # 深拷贝，慢！
    messages = copy.deepcopy(history)
    messages.append(new_msg)
    return messages
```

**优化后**：
```python
def build_messages(self, history, new_msg):
    # 浅拷贝，Message 对象不可变所以安全
    return [*history, new_msg]  # 或 list(history) + [new_msg]
```

**更激进的优化**：
```python
def run(self, prompt, messages=None):
    # 直接修改原列表（需要文档说明）
    if messages is None:
        messages = []

    messages.append(Message(role="user", content=prompt))
    response = self.model.invoke(messages, tools=self._tool_schemas)
    messages.append(Message(role="assistant", content=response.content))

    return response
```

**预期收益**：减少 50-100ms

### 3. 可选的 Pydantic 验证

**问题**：生产环境不需要运行时验证

**优化前**：
```python
class Message(BaseModel):
    role: str
    content: str
    # 每次赋值都验证类型
```

**优化后**：
```python
from pydantic import ConfigDict

class Message(BaseModel):
    model_config = ConfigDict(
        validate_assignment=False,  # 关闭运行时验证
        arbitrary_types_allowed=True
    )

    role: str
    content: str

# 或者提供两个版本
class StrictMessage(BaseModel):
    """开发环境使用，完整验证"""
    pass

class FastMessage(BaseModel):
    """生产环境使用，最小验证"""
    model_config = ConfigDict(validate_assignment=False)
```

**预期收益**：减少 50-100ms

### 4. 移除默认监控

**问题**：监控系统默认开启，数据库写入慢

**优化前**：
```python
class Agent:
    def __init__(self, ...):
        self.monitor = Monitor()  # 默认开启

    def run(self, prompt):
        self.monitor.log_start()
        response = self.model.invoke(...)
        self.monitor.log_end(response)  # 每次都写 DB
```

**优化后**：
```python
class FastAgent:
    def __init__(self, monitor=None):  # 改为可选
        self.monitor = monitor

    def run(self, prompt):
        if self.monitor:  # 只在需要时记录
            self.monitor.log_start()

        response = self.model.invoke(...)

        if self.monitor:
            self.monitor.log_end(response)

        return response
```

**预期收益**：减少 100-200ms

### 5. 纯同步路径

**问题**：在同步函数里调用 asyncio.run() 有开销

**优化前**：
```python
def run(self, prompt):
    # 即使是同步调用，内部也用 async
    return asyncio.run(self.arun(prompt))
```

**优化后**：
```python
def run(self, prompt):
    # 提供真正的同步实现
    response = self.model.invoke_sync(...)  # 纯同步方法
    return response

async def arun(self, prompt):
    # 异步路径独立实现
    response = await self.model.ainvoke(...)
    return response
```

**预期收益**：减少 50-100ms

### 快速优化总结

| 优化项 | 预期收益 | 实现难度 |
|--------|---------|---------|
| Schema 预编译 | 100-150ms | 简单 |
| 消息零拷贝 | 50-100ms | 简单 |
| 关闭 Pydantic 验证 | 50-100ms | 中等 |
| 移除默认监控 | 100-200ms | 简单 |
| 纯同步路径 | 50-100ms | 中等 |
| **总计** | **350-650ms** | **1-3天** |

## 架构级优化

目标：**1-2 周完成，再减少 300ms**

### 方案 A：零抽象层（最快但灵活性低）

**直接调用 Provider SDK，最小封装**

```python
class BareAgent:
    """极简 Agent，牺牲功能换取性能"""

    def __init__(self, model_id, api_key, tools):
        self.model_id = model_id
        self.api_key = api_key

        # 预编译所有可能需要的东西
        self.client = openai.OpenAI(api_key=api_key)
        self._tool_schemas = self._compile_tools(tools)
        self._tool_map = {t["function"]["name"]: t for t in tools}

    def run(self, prompt, history=[]):
        # 直接构造 OpenAI 格式（不经过 Message 抽象）
        messages = [
            {"role": "system", "content": self.system_prompt},
            *history,  # 假设已经是 dict 格式
            {"role": "user", "content": prompt}
        ]

        # 直接调用（不经过 Model 抽象）
        response = self.client.chat.completions.create(
            model=self.model_id,
            messages=messages,
            tools=self._tool_schemas
        )

        # 最小化解析
        choice = response.choices[0]
        if choice.message.tool_calls:
            return self._execute_tools_fast(choice.message.tool_calls)

        return choice.message.content

    def _execute_tools_fast(self, tool_calls):
        """最小化工具执行流程"""
        for call in tool_calls:
            func_name = call.function.name
            func = self._tool_map[func_name]
            args = json.loads(call.function.arguments)
            result = func(**args)  # 直接调用，无钩子无验证
            # 继续...
```

**优缺点**：
- ✅ 性能最优（接近裸 HTTP）
- ❌ 缺少抽象层，难以切换 provider
- ❌ 缺少错误处理、重试、监控
- ❌ 难以维护和扩展

**适用场景**：对性能极度敏感的生产环境，单一 provider

### 方案 B：双模式架构（推荐）

**提供两套 API：开发模式 vs 生产模式**

```python
# 开发模式：完整功能
class Agent:
    """完整的 Agent，包含所有功能"""

    def __init__(self, model, tools, strict=True, monitor=True, cache=True):
        self.strict = strict          # Pydantic 验证
        self.monitor = monitor        # 监控系统
        self.cache = cache            # 响应缓存
        # ... 完整功能

# 生产模式：极简高效
class FastAgent(Agent):
    """高性能 Agent，牺牲部分功能"""

    def __init__(self, model, tools):
        # 强制关闭所有开销大的功能
        super().__init__(
            model=model,
            tools=tools,
            strict=False,      # 不验证
            monitor=False,     # 不监控
            cache=False        # 不缓存（缓存可能有额外开销）
        )

        # 额外优化
        self._precompile_everything()  # 预编译所有东西

    def _precompile_everything(self):
        """启动时完成所有可以预计算的东西"""
        self._tool_schemas = [t.to_json_schema() for t in self.tools]
        self._tool_map = {t.name: t for t in self.tools}
        self._system_message = Message(role="system", content=self.system_prompt)
        # ...

# 使用方式
# 开发时
agent = Agent(model=..., tools=..., monitor=True, cache=True)

# 生产时
agent = FastAgent(model=..., tools=...)
```

**优缺点**：
- ✅ 兼顾性能和功能
- ✅ API 基本兼容，容易切换
- ✅ 开发和生产分离，各司其职
- ⚠️ 需要维护两套实现

### 方案 C：编译时优化（长期方案）

**使用 Cython/mypyc 编译热路径**

```python
# agent_core.pyx (Cython 文件)
cdef class FastMessage:
    cdef public str role
    cdef public str content
    cdef public list tool_calls

    def __init__(self, str role, str content):
        self.role = role
        self.content = content
        self.tool_calls = []

# 编译后性能提升 2-5x
```

**或使用 Rust 重写关键模块**：
```rust
// 用 PyO3 编写 Python 扩展
#[pyfunction]
fn fast_parse_response(response: &str) -> PyResult<ModelResponse> {
    // Rust 解析速度 > Python 10x
}
```

## 底层优化

目标：**可选，深度优化场景**

### 1. 使用 msgspec 替代 Pydantic

**Pydantic vs msgspec 性能对比**：

| 库 | 序列化 | 反序列化 | 验证 |
|-----|--------|----------|------|
| Pydantic | 基准 | 基准 | 基准 |
| msgspec | **10x** | **20x** | **15x** |

**实现**：
```python
import msgspec

# 使用 msgspec.Struct 替代 Pydantic BaseModel
class Message(msgspec.Struct):
    role: str
    content: str
    tool_calls: list = []

    # msgspec 自动生成高效的序列化代码

# 序列化/反序列化
encoder = msgspec.json.Encoder()
decoder = msgspec.json.Decoder(Message)

msg = Message(role="user", content="hello")
json_bytes = encoder.encode(msg)  # 比 Pydantic 快 10x
msg = decoder.decode(json_bytes)  # 比 Pydantic 快 20x
```

**预期收益**：减少 100-200ms

### 2. 使用 orjson 替代标准 json

**json vs orjson 性能对比**：

| 操作 | json | orjson | 加速比 |
|------|------|--------|--------|
| dumps | 基准 | **2-3x** | 2-3x |
| loads | 基准 | **2-3x** | 2-3x |

**实现**：
```python
import orjson

# 替换所有 json.dumps/loads
def serialize(obj):
    return orjson.dumps(obj)  # 返回 bytes

def deserialize(data):
    return orjson.loads(data)
```

**预期收益**：减少 20-50ms

### 3. 工具并行执行（进程池）

**问题**：Python GIL 限制 CPU 密集型任务并行

**解决方案**：
```python
from concurrent.futures import ProcessPoolExecutor

class FastAgent:
    def __init__(self):
        # 使用进程池而不是线程池
        self.executor = ProcessPoolExecutor(max_workers=4)

    def execute_tools(self, tool_calls):
        # CPU 密集型工具用进程并行
        futures = [
            self.executor.submit(self._run_tool, call)
            for call in tool_calls
        ]

        # 等待所有完成
        results = [f.result() for f in futures]
        return results

    def _run_tool(self, call):
        # 这个函数在独立进程中执行，无 GIL 限制
        tool = self._tool_map[call.name]
        return tool.execute(call.arguments)
```

**注意**：
- 只对 CPU 密集型工具有效（计算、数据处理等）
- IO 密集型工具用异步更好
- 进程创建有开销，只在工具执行时间 >100ms 时值得

**预期收益**：多工具场景减少 50-200ms

### 4. 响应流式解析

**问题**：等待完整响应再解析，延迟高

**优化**：
```python
async def stream_parse(self, response_stream):
    """边接收边解析，不等完整响应"""
    buffer = ""

    async for chunk in response_stream:
        buffer += chunk

        # 尝试解析部分内容
        if self._can_parse_partial(buffer):
            partial_response = self._parse_partial(buffer)
            yield partial_response
            buffer = ""  # 清空已解析部分

    # 最后处理剩余内容
    if buffer:
        yield self._parse_final(buffer)
```

**预期收益**：首字节延迟减少 50-100ms

## 性能测试

### 测试框架

```python
import time
import statistics
from typing import List

class PerformanceBenchmark:
    def __init__(self, agent, n_runs=100):
        self.agent = agent
        self.n_runs = n_runs

    def run(self, prompt="Hello") -> dict:
        """运行 benchmark 并返回统计数据"""
        times = []

        for i in range(self.n_runs):
            start = time.perf_counter()
            self.agent.run(prompt)
            elapsed = time.perf_counter() - start
            times.append(elapsed * 1000)  # 转换为 ms

        return {
            "mean": statistics.mean(times),
            "median": statistics.median(times),
            "p95": self._percentile(times, 95),
            "p99": self._percentile(times, 99),
            "min": min(times),
            "max": max(times),
            "stddev": statistics.stdev(times)
        }

    def _percentile(self, data: List[float], p: float) -> float:
        """计算百分位数"""
        sorted_data = sorted(data)
        index = int(len(sorted_data) * p / 100)
        return sorted_data[index]

    def compare(self, baseline_agent):
        """对比两个 agent 的性能"""
        print("Running baseline benchmark...")
        baseline_stats = self.run()

        print("Running optimized benchmark...")
        optimized_stats = PerformanceBenchmark(self.agent, self.n_runs).run()

        print("\n" + "="*50)
        print("PERFORMANCE COMPARISON")
        print("="*50)

        for metric in ["mean", "median", "p95", "p99"]:
            baseline_val = baseline_stats[metric]
            optimized_val = optimized_stats[metric]
            improvement = (baseline_val - optimized_val) / baseline_val * 100

            print(f"{metric.upper():8s}: {baseline_val:6.1f}ms → {optimized_val:6.1f}ms "
                  f"({improvement:+.1f}%)")

        return baseline_stats, optimized_stats

# 使用示例
baseline_agent = Agent(model=..., tools=...)
optimized_agent = FastAgent(model=..., tools=...)

benchmark = PerformanceBenchmark(optimized_agent)
benchmark.compare(baseline_agent)
```

### 预期输出

```
==================================================
PERFORMANCE COMPARISON
==================================================
MEAN    : 1700.5ms → 950.2ms (-44.1%)
MEDIAN  : 1680.0ms → 920.0ms (-45.2%)
P95     : 1850.3ms → 1100.5ms (-40.5%)
P99     : 1950.8ms → 1200.2ms (-38.5%)
```

### Profiling 工具

#### 1. 使用 cProfile
```bash
python -m cProfile -o output.prof your_script.py

# 分析结果
python -m pstats output.prof
>>> sort cumtime
>>> stats 20  # 显示最慢的 20 个函数
```

#### 2. 使用 py-spy（推荐）
```bash
# 安装
pip install py-spy

# 生成火焰图
py-spy record -o profile.svg -- python your_script.py

# 实时查看
py-spy top -- python your_script.py
```

#### 3. 使用 line_profiler（行级分析）
```bash
# 安装
pip install line_profiler

# 在代码中标记要分析的函数
@profile
def slow_function():
    pass

# 运行
kernprof -l -v your_script.py
```

### 测试用例

```python
# tests/test_performance.py
import pytest
from sakura import Agent, FastAgent

@pytest.fixture
def agents():
    model = OpenAI(id="gpt-3.5-turbo")
    tools = [search_tool, calculator_tool]

    return {
        "baseline": Agent(model=model, tools=tools),
        "optimized": FastAgent(model=model, tools=tools)
    }

def test_simple_query_performance(agents, benchmark):
    """测试简单查询性能"""
    def run():
        agents["optimized"].run("What is 2+2?")

    result = benchmark(run)

    # 确保 p95 延迟 < 1000ms
    assert result.stats["mean"] < 1000, "Mean latency too high"

def test_tool_call_performance(agents, benchmark):
    """测试工具调用性能"""
    def run():
        agents["optimized"].run("Search for Python tutorials")

    result = benchmark(run)
    assert result.stats["p95"] < 1500, "P95 latency too high"

def test_vs_baseline(agents):
    """对比优化前后"""
    baseline = PerformanceBenchmark(agents["baseline"], n_runs=50)
    optimized = PerformanceBenchmark(agents["optimized"], n_runs=50)

    baseline_stats = baseline.run()
    optimized_stats = optimized.run()

    improvement = (baseline_stats["mean"] - optimized_stats["mean"]) / baseline_stats["mean"]

    # 确保至少有 40% 的性能提升
    assert improvement >= 0.40, f"Performance improvement only {improvement*100:.1f}%"
```

## 优化检查清单

### Phase 1: 快速优化 (1-3 天)

- [ ] 工具 Schema 预编译（启动时生成一次）
- [ ] 消息列表使用浅拷贝而不是深拷贝
- [ ] 关闭 Pydantic 运行时验证（生产环境）
- [ ] 监控系统改为可选（默认关闭）
- [ ] 提供纯同步执行路径（避免 asyncio 开销）
- [ ] 运行 profiler 验证优化效果
- [ ] Benchmark 确认减少 350-650ms

### Phase 2: 架构优化 (1-2 周)

- [ ] 实现 FastAgent 类（生产模式）
- [ ] 移除不必要的中间层抽象
- [ ] 优化消息构建流程
- [ ] 缓存系统提取为可选插件
- [ ] 重试逻辑提取为装饰器（可选）
- [ ] Benchmark 确认再减少 200-300ms

### Phase 3: 底层优化 (可选)

- [ ] 评估 msgspec 替换 Pydantic
- [ ] 使用 orjson 替换标准 json
- [ ] 工具执行用进程池（CPU 密集型场景）
- [ ] 实现流式解析（降低首字节延迟）
- [ ] Benchmark 确认最终性能

### 性能测试

- [ ] 搭建 benchmark 框架
- [ ] 编写性能测试用例
- [ ] 对比不同优化方案
- [ ] 生成性能报告
- [ ] 建立持续性能监控

### 文档和部署

- [ ] 更新性能数据到文档
- [ ] 提供优化最佳实践指南
- [ ] 生产环境配置示例
- [ ] 性能调优 FAQ

## 最终目标

| 指标 | 原始 agno | 优化后 Sakura | 改进 |
|------|-----------|--------------|------|
| 平均延迟 | 1700ms | <1000ms | **-41%** |
| P95 延迟 | 1850ms | <1100ms | **-40%** |
| P99 延迟 | 1950ms | <1200ms | **-38%** |
| 框架开销 | 1000ms | <300ms | **-70%** |

## 注意事项

### 1. 不要过早优化
- 先用 profiler 找出真正的瓶颈
- 优化最耗时的 20% 代码即可
- 保持代码可读性和可维护性

### 2. 权衡取舍
- 性能 vs 功能：FastAgent 牺牲了部分功能
- 性能 vs 可维护性：过度优化会增加复杂度
- 性能 vs 兼容性：某些优化可能破坏 API

### 3. 持续监控
- 建立性能基准测试
- 每次提交运行 benchmark
- 监控生产环境实际性能

### 4. 文档化
- 记录每次优化的收益
- 说明优化的前提条件
- 提供性能调优指南

## 下一步

完成性能优化后，继续阅读：
- [完整使用指南](./guide.md) - 了解所有功能
- [架构总览](./01-architecture-overview.md) - 了解整体设计
- [实施路线图](./roadmap.md) - 了解开发计划
