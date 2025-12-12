# 错误处理与重试最佳实践报告

> 基于 LangChain、Portkey、行业实践的深度分析

---

## 1. 核心挑战

LLM Agent 面临的错误类型：

| 类型 | 示例 | 可重试 |
|------|------|--------|
| **暂态错误** | 网络超时、速率限制 | ✅ |
| **永久错误** | API 密钥无效、模型不存在 | ❌ |
| **内容错误** | 格式错误、幻觉 | 部分 |
| **工具错误** | 外部服务故障 | ✅ |

---

## 2. 行业实现模式

### 2.1 指数退避重试

```python
import time
import random
from functools import wraps

def retry_with_exponential_backoff(
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    jitter: bool = True,
    retryable_errors: tuple = (TimeoutError, ConnectionError)
):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except retryable_errors as e:
                    last_exception = e
                    if attempt == max_retries:
                        raise
                    
                    delay = min(base_delay * (2 ** attempt), max_delay)
                    if jitter:
                        delay *= (0.5 + random.random())
                    
                    time.sleep(delay)
            
            raise last_exception
        return wrapper
    return decorator

# 使用
@retry_with_exponential_backoff(max_retries=3)
def call_llm(prompt: str) -> str:
    return api.generate(prompt)
```

### 2.2 多模型降级

```python
class ModelFallbackChain:
    """多模型降级链"""
    
    def __init__(self, models: list[str]):
        self.models = models  # 按优先级排序
    
    def generate(self, prompt: str) -> str:
        last_error = None
        
        for model in self.models:
            try:
                return call_model(model, prompt)
            except Exception as e:
                last_error = e
                log_warning(f"{model} failed: {e}, trying next...")
                continue
        
        raise RuntimeError(f"All models failed. Last: {last_error}")

# 使用
chain = ModelFallbackChain([
    "qwen-plus",     # 首选
    "qwen-turbo",    # 备选
    "gpt-4o-mini"    # 最后选择
])
```

### 2.3 熔断器模式

```python
from dataclasses import dataclass
from enum import Enum
import time

class CircuitState(Enum):
    CLOSED = "closed"      # 正常
    OPEN = "open"          # 熔断
    HALF_OPEN = "half_open"  # 试探

@dataclass
class CircuitBreaker:
    failure_threshold: int = 5
    recovery_timeout: float = 60.0
    
    def __post_init__(self):
        self.failures = 0
        self.state = CircuitState.CLOSED
        self.last_failure_time = 0
    
    def call(self, func, *args, **kwargs):
        if self.state == CircuitState.OPEN:
            if time.time() - self.last_failure_time > self.recovery_timeout:
                self.state = CircuitState.HALF_OPEN
            else:
                raise RuntimeError("Circuit breaker is OPEN")
        
        try:
            result = func(*args, **kwargs)
            if self.state == CircuitState.HALF_OPEN:
                self.state = CircuitState.CLOSED
                self.failures = 0
            return result
        except Exception as e:
            self.failures += 1
            self.last_failure_time = time.time()
            
            if self.failures >= self.failure_threshold:
                self.state = CircuitState.OPEN
            raise
```

---

## 3. Sakura 推荐实现

### 3.1 RetryPolicy 类

```python
@dataclass
class RetryPolicy:
    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    jitter: bool = True
    retryable_exceptions: tuple = (TimeoutError, ConnectionError)
    
    # 根据错误码判断
    retryable_status_codes: set = field(default_factory=lambda: {429, 500, 502, 503})

    def should_retry(self, error: Exception) -> bool:
        if isinstance(error, self.retryable_exceptions):
            return True
        
        # 检查 HTTP 状态码
        if hasattr(error, 'status_code'):
            return error.status_code in self.retryable_status_codes
        
        return False
    
    def get_delay(self, attempt: int) -> float:
        delay = min(self.base_delay * (2 ** attempt), self.max_delay)
        if self.jitter:
            delay *= (0.5 + random.random())
        return delay
```

### 3.2 ErrorHandler 类

```python
class ErrorHandler:
    """统一错误处理器"""
    
    def __init__(
        self,
        retry_policy: RetryPolicy = None,
        fallback_models: list[str] = None,
        on_error: Callable = None
    ):
        self.retry_policy = retry_policy or RetryPolicy()
        self.fallback_models = fallback_models or []
        self.on_error = on_error
    
    def execute(self, func: Callable, *args, **kwargs):
        last_error = None
        
        # 重试主函数
        for attempt in range(self.retry_policy.max_retries + 1):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                last_error = e
                
                if self.on_error:
                    self.on_error(e, attempt)
                
                if not self.retry_policy.should_retry(e):
                    break
                
                if attempt < self.retry_policy.max_retries:
                    delay = self.retry_policy.get_delay(attempt)
                    time.sleep(delay)
        
        # 尝试降级模型
        for model in self.fallback_models:
            try:
                return func(*args, model=model, **kwargs)
            except:
                continue
        
        raise last_error
```

### 3.3 集成到 Agent

```python
@dataclass
class Agent:
    retry_policy: Optional[RetryPolicy] = None
    fallback_models: list[str] = field(default_factory=list)
    
    def run(self, prompt: str, **kwargs):
        handler = ErrorHandler(
            retry_policy=self.retry_policy,
            fallback_models=self.fallback_models,
            on_error=lambda e, a: log_warning(f"Attempt {a} failed: {e}")
        )
        
        return handler.execute(self._run_internal, prompt, **kwargs)
```

---

## 4. 工具级错误处理

```python
@tool(
    retry_policy=RetryPolicy(max_retries=2),
    fallback=lambda args: "Service unavailable"
)
def search_web(query: str) -> str:
    return external_api.search(query)

# 或使用装饰器
@with_retry(max_retries=3, on_fail="return_empty")
@tool
def fetch_data(url: str) -> str:
    return requests.get(url).text
```

---

## 5. 配置示例

```python
from sakura import Agent
from sakura.error_handling import RetryPolicy

agent = Agent(
    model="qwen-plus",
    tools=[...],
    
    # 重试配置
    retry_policy=RetryPolicy(
        max_retries=3,
        base_delay=1.0,
        retryable_exceptions=(TimeoutError, RateLimitError)
    ),
    
    # 降级模型
    fallback_models=["qwen-turbo", "gpt-4o-mini"]
)
```

---

## 6. 错误分类与处理策略

| 错误类型 | 策略 | 示例 |
|----------|------|------|
| 速率限制 | 指数退避 | 429 Too Many Requests |
| 服务不可用 | 模型降级 | 503 Service Unavailable |
| 超时 | 重试 + 超时增加 | 网络超时 |
| 格式错误 | 重新生成 | JSON 解析失败 |
| 内容违规 | 不重试 | 内容被拒绝 |
| 认证失败 | 不重试 | 401 Unauthorized |

---

## 7. 与其他功能关系

| 功能 | 错误处理集成 |
|------|-------------|
| **HITL** | 人工介入处理复杂错误 |
| **Observability** | 记录错误和重试详情 |
| **SubAgent** | 子 Agent 独立错误处理 |
| **Parallel** | 单工具失败不影响其他 |
