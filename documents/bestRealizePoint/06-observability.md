# 可观测性（Observability）最佳实践报告

> 基于 OpenTelemetry、LangSmith 的深度分析

---

## 1. 核心概念

### 为什么 LLM Agent 需要可观测性

| 维度 | 传统应用 | LLM Agent |
|------|----------|-----------|
| **输入** | 请求参数 | Prompt、上下文 |
| **输出** | 响应数据 | 生成内容、工具调用 |
| **质量** | 错误率 | 幻觉率、任务完成率 |
| **成本** | 计算资源 | Token 消耗 |

### 三支柱

- **Metrics**：Token 用量、延迟、错误率
- **Tracing**：请求链路、工具调用、Agent 步骤
- **Logging**：原始请求、模型响应、错误堆栈

---

## 2. 行业实现

### OpenTelemetry

```python
from opentelemetry import trace

tracer = trace.get_tracer(__name__)

@tracer.start_as_current_span("agent.run")
def run_agent(prompt: str):
    span = trace.get_current_span()
    span.set_attribute("llm.prompt", prompt)
    span.set_attribute("llm.model", "qwen-plus")
    return model.generate(prompt)
```

### LangSmith

```python
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_API_KEY"] = "your-key"

@traceable(name="custom_function")
def process_data(data: dict) -> dict:
    return result
```

---

## 3. Sakura 推荐实现

### 3.1 Span 类

```python
@dataclass
class Span:
    name: str
    trace_id: str
    span_id: str
    parent_id: Optional[str] = None
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None
    attributes: dict = field(default_factory=dict)
    
    def set_attribute(self, key: str, value: Any):
        self.attributes[key] = value
    
    def end(self):
        self.end_time = time.time()
    
    @property
    def duration_ms(self) -> float:
        return (self.end_time - self.start_time) * 1000 if self.end_time else 0
```

### 3.2 Tracer

```python
class Tracer:
    def __init__(self):
        self._exporters = []
        self._enabled = False
    
    def enable(self, exporters: list):
        self._enabled = True
        self._exporters = exporters
    
    @contextmanager
    def start_span(self, name: str, attributes: dict = None):
        if not self._enabled:
            yield None
            return
        
        span = Span(name=name, trace_id=..., span_id=...)
        if attributes:
            span.attributes.update(attributes)
        
        try:
            yield span
        finally:
            span.end()
            self._export(span)
```

### 3.3 指标收集

```python
@dataclass
class AgentMetrics:
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_calls: int = 0
    latencies: list = field(default_factory=list)
    
    def record_call(self, tokens: dict, latency_ms: float):
        self.total_calls += 1
        self.total_prompt_tokens += tokens.get("prompt", 0)
        self.total_completion_tokens += tokens.get("completion", 0)
        self.latencies.append(latency_ms)
    
    @property
    def avg_latency(self) -> float:
        return sum(self.latencies) / len(self.latencies) if self.latencies else 0
```

### 3.4 结构化日志

```python
class StructuredFormatter(logging.Formatter):
    def format(self, record) -> str:
        return json.dumps({
            "timestamp": datetime.utcnow().isoformat(),
            "level": record.levelname,
            "message": record.getMessage(),
            "trace_id": getattr(record, 'trace_id', None)
        })
```

---

## 4. 使用示例

```python
from sakura import Agent
from sakura.observability import tracer, ConsoleExporter, AgentMetrics

tracer.enable([ConsoleExporter()])
metrics = AgentMetrics()

agent = Agent(
    model="qwen-plus",
    enable_tracing=True,
    metrics=metrics
)

result = agent.run("分析代码...")
print(metrics.report())
```

---

## 5. 关键指标

| 指标 | 说明 |
|------|------|
| Token 用量 | input/output tokens |
| 延迟 P95 | 95% 请求延迟 |
| 错误率 | 失败调用占比 |
| 工具成功率 | 各工具执行成功率 |
| 成本估算 | 基于 Token 价格 |
