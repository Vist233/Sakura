# 可观测性（Observability）最佳实践报告

> 基于 OpenTelemetry、LangSmith、LangFuse 及行业最新实践的深度分析

---

## 1. 核心概念

### 为什么 LLM Agent 需要可观测性

| 维度 | 传统应用 | LLM Agent |
|------|----------|-----------| 
| **输入** | 请求参数 | Prompt、上下文、历史消息 |
| **输出** | 响应数据 | 生成内容、工具调用、推理过程 |
| **质量** | 错误率 | 幻觉率、任务完成率、用户满意度 |
| **成本** | 计算资源 | Token 消耗、API 费用 |
| **可解释性** | 日志 | 思考链、工具选择原因 |

### 三支柱 + LLM 扩展

```
┌────────────────────────────────────────────────┐
│              LLM Observability                 │
├────────────┬────────────┬────────────┬─────────┤
│  Metrics   │  Tracing   │  Logging   │  Cost   │
│ Token 用量  │ 请求链路    │ 原始请求    │ API 费用 │
│ 延迟 P95   │ 工具调用    │ 模型响应    │ 成本预测 │
│ 错误率     │ Agent 步骤  │ 错误堆栈    │ 预算告警 │
└────────────┴────────────┴────────────┴─────────┘
```

---

## 2. 行业实现对比

### 2.1 OpenTelemetry Semantic Conventions for GenAI

OpenTelemetry 1.37+ 定义了 GenAI 语义约定：

```python
# 标准属性
span.set_attribute("gen_ai.system", "openai")
span.set_attribute("gen_ai.request.model", "gpt-4o")
span.set_attribute("gen_ai.request.temperature", 0.7)
span.set_attribute("gen_ai.usage.prompt_tokens", 150)
span.set_attribute("gen_ai.usage.completion_tokens", 80)
span.set_attribute("gen_ai.response.finish_reasons", ["stop"])
```

### 2.2 LangSmith

```python
# 环境配置即可启用
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_API_KEY"] = "your-key"
os.environ["LANGCHAIN_PROJECT"] = "my-project"

# 自动追踪 + 成本计算
# LangSmith 内置各模型价格表，自动计算成本
```

**特点**：
- 自动 Token 计费（内置价格表）
- 项目/运行级成本聚合
- 支持自定义价格覆盖

### 2.3 LangFuse

```python
from langfuse.decorators import observe

@observe()
def my_llm_function(prompt: str):
    # 自动追踪 Token、延迟、成本
    return llm.generate(prompt)
```

**特点**：
- 开源，可自托管
- 基于 OpenTelemetry
- 用户级成本追踪

---

## 3. Context Propagation（上下文传播）

### 3.1 为什么重要

在分布式 LLM 应用中，请求可能经过：
1. 用户界面 → AI 后端
2. Prompt 工程组件
3. 多个 LLM 链式调用
4. Agent → SubAgent 调用
5. LLM → 外部工具调用

**必须确保 trace_id 在所有环节传递**。

### 3.2 W3C Trace Context 标准

```python
import contextvars
from dataclasses import dataclass
from typing import Optional
import uuid

# 使用 contextvars 实现跨异步边界的上下文传递
_current_context: contextvars.ContextVar["TraceContext"] = contextvars.ContextVar("trace_context")


@dataclass
class TraceContext:
    """W3C Trace Context 兼容的上下文"""
    trace_id: str
    span_id: str
    parent_span_id: Optional[str] = None
    
    @classmethod
    def new_trace(cls) -> "TraceContext":
        """创建新的追踪上下文"""
        return cls(
            trace_id=uuid.uuid4().hex,
            span_id=uuid.uuid4().hex[:16]
        )
    
    def create_child(self) -> "TraceContext":
        """创建子 Span 的上下文"""
        return TraceContext(
            trace_id=self.trace_id,
            span_id=uuid.uuid4().hex[:16],
            parent_span_id=self.span_id
        )
    
    def to_traceparent(self) -> str:
        """转换为 W3C traceparent 格式"""
        return f"00-{self.trace_id}-{self.span_id}-01"
    
    @classmethod
    def from_traceparent(cls, header: str) -> Optional["TraceContext"]:
        """从 traceparent 头解析"""
        parts = header.split("-")
        if len(parts) >= 3:
            return cls(trace_id=parts[1], span_id=parts[2])
        return None


def get_current_context() -> Optional[TraceContext]:
    """获取当前上下文"""
    return _current_context.get(None)


def set_current_context(ctx: TraceContext):
    """设置当前上下文"""
    _current_context.set(ctx)
```

### 3.3 跨 SubAgent 传播

```python
async def call_subagent(config: str, prompt: str):
    # 获取当前上下文
    parent_ctx = get_current_context()
    
    # 创建子上下文
    child_ctx = parent_ctx.create_child() if parent_ctx else TraceContext.new_trace()
    
    # 传递给 SubAgent
    subagent = create_subagent(
        config=config,
        trace_context=child_ctx  # 传递上下文
    )
    
    return await subagent.arun(prompt)
```

---

## 4. 采样策略（Sampling）

### 4.1 Head-Based vs Tail-Based

| 策略 | 决策时机 | 优点 | 缺点 | 适用场景 |
|------|----------|------|------|----------|
| **Head-Based** | Trace 开始时 | 高效、简单 | 可能丢失错误 Trace | 高流量、成本敏感 |
| **Tail-Based** | Trace 结束后 | 可基于结果决策 | 内存开销大 | 需捕获所有错误 |
| **Hybrid** | 组合使用 | 兼顾效率和质量 | 配置复杂 | 生产推荐 |

### 4.2 推荐配置

```python
from dataclasses import dataclass
from typing import Callable, Optional
import random


@dataclass
class SamplingConfig:
    """采样配置"""
    
    # Head-based: 基础采样率
    base_rate: float = 0.1  # 10% 随机采样
    
    # Tail-based: 强制采样条件
    always_sample_errors: bool = True      # 错误 Trace 必采
    always_sample_slow: bool = True        # 慢请求必采
    slow_threshold_ms: float = 5000        # 慢请求阈值
    
    # 特殊规则
    always_sample_tools: list = None       # 特定工具必采
    
    def should_sample_head(self, trace_id: str) -> bool:
        """Head-based 采样决策"""
        # 使用 trace_id 的哈希确保一致性
        hash_value = int(trace_id[:8], 16) / 0xFFFFFFFF
        return hash_value < self.base_rate
    
    def should_sample_tail(
        self,
        has_error: bool,
        duration_ms: float,
        tool_names: list
    ) -> bool:
        """Tail-based 采样决策"""
        if self.always_sample_errors and has_error:
            return True
        
        if self.always_sample_slow and duration_ms > self.slow_threshold_ms:
            return True
        
        if self.always_sample_tools:
            if any(t in self.always_sample_tools for t in tool_names):
                return True
        
        return False


# 生产推荐配置
PRODUCTION_SAMPLING = SamplingConfig(
    base_rate=0.05,              # 5% 随机采样
    always_sample_errors=True,   # 所有错误
    always_sample_slow=True,     # 所有慢请求
    slow_threshold_ms=3000,      # 3 秒阈值
    always_sample_tools=["write_file", "execute_code"]  # 高风险工具
)
```

---

## 5. 成本追踪（Cost Tracking）

### 5.1 Token 价格表

```python
from dataclasses import dataclass
from typing import Dict, Optional
from datetime import datetime


# 主流模型价格（美元 / 1M tokens，2024年12月）
TOKEN_PRICES: Dict[str, Dict[str, float]] = {
    # OpenAI
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4-turbo": {"input": 10.00, "output": 30.00},
    "o1": {"input": 15.00, "output": 60.00},
    
    # Anthropic
    "claude-3-5-sonnet": {"input": 3.00, "output": 15.00},
    "claude-3-5-haiku": {"input": 0.80, "output": 4.00},
    "claude-3-opus": {"input": 15.00, "output": 75.00},
    
    # Qwen
    "qwen-plus": {"input": 0.80, "output": 2.00},
    "qwen-turbo": {"input": 0.30, "output": 0.60},
    "qwen-max": {"input": 2.40, "output": 9.60},
    
    # DeepSeek
    "deepseek-chat": {"input": 0.14, "output": 0.28},
    "deepseek-coder": {"input": 0.14, "output": 0.28},
}


@dataclass
class CostTracker:
    """成本追踪器"""
    
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cost_usd: float = 0
    
    calls_by_model: Dict[str, int] = None
    cost_by_model: Dict[str, float] = None
    
    def __post_init__(self):
        self.calls_by_model = {}
        self.cost_by_model = {}
    
    def record(
        self,
        model: str,
        input_tokens: int,
        output_tokens: int
    ) -> float:
        """记录一次调用，返回本次成本"""
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        
        # 计算成本
        cost = self.estimate_cost(model, input_tokens, output_tokens)
        self.total_cost_usd += cost
        
        # 按模型统计
        self.calls_by_model[model] = self.calls_by_model.get(model, 0) + 1
        self.cost_by_model[model] = self.cost_by_model.get(model, 0) + cost
        
        return cost
    
    @staticmethod
    def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
        """估算成本（美元）"""
        model_lower = model.lower()
        
        # 查找匹配的价格
        for key, prices in TOKEN_PRICES.items():
            if key in model_lower:
                input_cost = (input_tokens / 1_000_000) * prices["input"]
                output_cost = (output_tokens / 1_000_000) * prices["output"]
                return input_cost + output_cost
        
        # 默认价格
        return (input_tokens + output_tokens * 3) / 1_000_000
    
    def report(self) -> str:
        """生成成本报告"""
        return f"""成本统计:
- 总输入 Token: {self.total_input_tokens:,}
- 总输出 Token: {self.total_output_tokens:,}
- 总成本: ${self.total_cost_usd:.4f}

按模型分布:
{self._model_breakdown()}"""
    
    def _model_breakdown(self) -> str:
        lines = []
        for model, cost in sorted(self.cost_by_model.items(), key=lambda x: -x[1]):
            calls = self.calls_by_model.get(model, 0)
            lines.append(f"  - {model}: ${cost:.4f} ({calls} 次)")
        return "\n".join(lines) if lines else "  (无数据)"
```

---

## 6. 完整 Span 类设计

```python
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import time
import json


@dataclass
class Span:
    """
    OpenTelemetry 兼容的 Span 实现
    
    支持 GenAI 语义约定
    """
    name: str
    trace_id: str
    span_id: str
    parent_id: Optional[str] = None
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None
    
    # 标准属性
    attributes: Dict[str, Any] = field(default_factory=dict)
    
    # 事件（日志点）
    events: List[Dict[str, Any]] = field(default_factory=list)
    
    # 状态
    status: str = "UNSET"  # UNSET, OK, ERROR
    status_message: Optional[str] = None
    
    def set_attribute(self, key: str, value: Any):
        """设置属性"""
        self.attributes[key] = value
    
    def set_llm_attributes(
        self,
        model: str,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        temperature: float = None,
        finish_reason: str = None
    ):
        """设置 LLM 特定属性（GenAI 语义约定）"""
        self.attributes["gen_ai.request.model"] = model
        self.attributes["gen_ai.usage.prompt_tokens"] = prompt_tokens
        self.attributes["gen_ai.usage.completion_tokens"] = completion_tokens
        
        if temperature is not None:
            self.attributes["gen_ai.request.temperature"] = temperature
        if finish_reason:
            self.attributes["gen_ai.response.finish_reasons"] = [finish_reason]
    
    def add_event(self, name: str, attributes: Dict[str, Any] = None):
        """添加事件"""
        self.events.append({
            "name": name,
            "timestamp": time.time(),
            "attributes": attributes or {}
        })
    
    def set_error(self, error: Exception):
        """标记为错误"""
        self.status = "ERROR"
        self.status_message = str(error)
        self.add_event("exception", {
            "exception.type": type(error).__name__,
            "exception.message": str(error)
        })
    
    def end(self):
        """结束 Span"""
        self.end_time = time.time()
        if self.status == "UNSET":
            self.status = "OK"
    
    @property
    def duration_ms(self) -> float:
        """持续时间（毫秒）"""
        if self.end_time:
            return (self.end_time - self.start_time) * 1000
        return 0
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为 OTLP 兼容格式"""
        return {
            "traceId": self.trace_id,
            "spanId": self.span_id,
            "parentSpanId": self.parent_id,
            "name": self.name,
            "startTimeUnixNano": int(self.start_time * 1e9),
            "endTimeUnixNano": int(self.end_time * 1e9) if self.end_time else None,
            "attributes": self.attributes,
            "events": self.events,
            "status": {"code": self.status, "message": self.status_message}
        }
```

---

## 7. Exporter 设计

```python
from abc import ABC, abstractmethod
from typing import List
import json


class Exporter(ABC):
    """导出器基类"""
    
    @abstractmethod
    def export(self, spans: List[Span]):
        """导出 Span 列表"""
        pass


class ConsoleExporter(Exporter):
    """控制台导出（开发调试）"""
    
    def export(self, spans: List[Span]):
        for span in spans:
            status = "✓" if span.status == "OK" else "✗"
            tokens = span.attributes.get("gen_ai.usage.prompt_tokens", 0) + \
                     span.attributes.get("gen_ai.usage.completion_tokens", 0)
            print(f"[{status}] {span.name} | {span.duration_ms:.0f}ms | {tokens} tokens")


class JSONFileExporter(Exporter):
    """JSON 文件导出"""
    
    def __init__(self, filepath: str):
        self.filepath = filepath
    
    def export(self, spans: List[Span]):
        with open(self.filepath, "a") as f:
            for span in spans:
                f.write(json.dumps(span.to_dict()) + "\n")


class OTLPExporter(Exporter):
    """OpenTelemetry Protocol 导出（对接 Jaeger/Grafana）"""
    
    def __init__(self, endpoint: str):
        self.endpoint = endpoint
    
    def export(self, spans: List[Span]):
        import httpx
        
        payload = {
            "resourceSpans": [{
                "scopeSpans": [{
                    "spans": [s.to_dict() for s in spans]
                }]
            }]
        }
        
        httpx.post(
            f"{self.endpoint}/v1/traces",
            json=payload,
            headers={"Content-Type": "application/json"}
        )
```

---

## 8. Sakura 集成方案

### 8.1 模块结构

```
sakura/
├── observability/
│   ├── __init__.py
│   ├── context.py      # TraceContext
│   ├── span.py         # Span
│   ├── tracer.py       # Tracer
│   ├── metrics.py      # AgentMetrics
│   ├── costs.py        # CostTracker
│   ├── sampling.py     # SamplingConfig
│   └── exporters/
│       ├── console.py
│       ├── json_file.py
│       └── otlp.py
```

### 8.2 使用示例

```python
from sakura import Agent
from sakura.observability import (
    Tracer, 
    ConsoleExporter, 
    CostTracker,
    SamplingConfig
)

# 配置追踪
tracer = Tracer()
tracer.enable([ConsoleExporter()])
tracer.set_sampling(SamplingConfig(
    base_rate=0.1,
    always_sample_errors=True
))

# 成本追踪
cost_tracker = CostTracker()

# 创建 Agent
agent = Agent(
    model="qwen-plus",
    tracer=tracer,
    cost_tracker=cost_tracker
)

# 运行
result = agent.run("分析这段代码...")

# 查看报告
print(cost_tracker.report())
```

---

## 9. 关键指标

| 指标 | 说明 | 推荐阈值 |
|------|------|----------|
| **Token 用量** | input/output tokens | 监控趋势 |
| **延迟 P95** | 95% 请求延迟 | < 5s |
| **错误率** | 失败调用占比 | < 1% |
| **工具成功率** | 各工具执行成功率 | > 95% |
| **成本/请求** | 平均单次成本 | 监控趋势 |
| **Token 效率** | output/input 比率 | 监控趋势 |

---

## 10. 总结

| 组件 | 推荐实现 |
|------|----------|
| Context Propagation | contextvars + W3C Trace Context |
| 采样策略 | Hybrid（Head + Tail） |
| 成本追踪 | 内置价格表 + 自动计算 |
| 导出 | 多 Exporter 支持（Console/JSON/OTLP） |
| 语义约定 | OpenTelemetry GenAI Semantic Conventions |
