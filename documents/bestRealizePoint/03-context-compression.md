# 上下文压缩最佳实践报告

> 基于 LongLLMLingua、LLMLingua-2 及行业实践的深度分析

---

## 1. 核心问题

### 为什么需要上下文压缩

| 问题 | 影响 |
|------|------|
| **成本** | Token 越多，API 费用越高 |
| **延迟** | 长上下文处理时间更长 |
| **Lost in the Middle** | LLM 容易忽略中间信息 |
| **上下文限制** | 超出窗口直接报错 |

### 关键指标

```
压缩率 = 原始 Token 数 / 压缩后 Token 数
保真度 = 压缩后输出质量 / 原始输出质量
```

理想目标：**高压缩率 + 高保真度**

---

## 2. 行业技术对比

### 2.1 LongLLMLingua（微软）

**核心思想**：Question-Aware 粗到细压缩

```
原始上下文
    │
    ▼
┌───────────────────────────┐
│   粗粒度压缩（文档级）       │
│   - 计算每个文档的困惑度     │
│   - 保留与问题相关的文档     │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│   细粒度压缩（Token 级）     │
│   - 评估每个 Token 重要性   │
│   - 动态分配压缩预算        │
└─────────────┬─────────────┘
              │
              ▼
┌───────────────────────────┐
│   文档重排序                │
│   - 重要信息放前面/后面     │
│   - 减轻 Lost in Middle    │
└───────────────────────────┘
```

**技术细节**：
- 使用小模型（如 LLaMA-2-7B）计算困惑度
- 困惑度低 = 模型更确信 = 信息更重要
- 支持 10x+ 压缩率

### 2.2 LLMLingua-2（微软）

**改进点**：
- 数据蒸馏（从 GPT-4 学习）
- Token 分类器（而非困惑度）
- 更快速度（无需逐 Token 计算）

```python
# LLMLingua-2 核心思路
def compress(text, target_ratio):
    # 使用轻量分类器标记每个 token 重要性
    importance_scores = classifier(text.tokens)
    
    # 保留得分高的 token
    threshold = calculate_threshold(importance_scores, target_ratio)
    compressed_tokens = [t for t, s in zip(text.tokens, importance_scores) if s > threshold]
    
    return join(compressed_tokens)
```

### 2.3 滑动窗口（简单有效）

```python
def sliding_window(messages, window_size=10):
    """保留最近 N 条消息"""
    return messages[-window_size:]
```

**优点**：简单快速，零额外开销
**缺点**：丢失早期重要信息

### 2.4 LLM 摘要压缩

```python
def summarize_compress(messages, summarizer_model):
    """使用 LLM 生成对话摘要"""
    history_text = format_messages(messages[:-5])  # 除最近 5 条
    
    summary = summarizer_model.chat(f"""
    请简明扼要地总结以下对话的关键信息：
    
    {history_text}
    
    只保留重要的：决策、结论、关键数据、待办事项。
    """)
    
    return [
        Message(role="system", content=f"[历史摘要]\n{summary}"),
        *messages[-5:]  # 保留最近 5 条
    ]
```

**优点**：保留语义信息
**缺点**：需要额外 API 调用

### 2.5 RAG 检索（语义召回）

```python
def rag_compress(messages, query, top_k=5):
    """基于语义相似度检索相关历史"""
    embeddings = embed_model.encode([m.content for m in messages])
    query_embedding = embed_model.encode(query)
    
    # 计算相似度
    similarities = cosine_similarity(query_embedding, embeddings)
    top_indices = np.argsort(similarities)[-top_k:]
    
    return [messages[i] for i in sorted(top_indices)]
```

**优点**：精确召回相关信息
**缺点**：需要向量模型和索引

---

## 3. 压缩策略对比

| 策略 | 压缩率 | 保真度 | 延迟 | 成本 | 适用场景 |
|------|--------|--------|------|------|----------|
| **滑动窗口** | 固定 | 低 | 0 | 0 | 简单对话 |
| **LLM 摘要** | 10-20x | 高 | 1-2s | 有 | 长对话 |
| **困惑度裁剪** | 5-10x | 中高 | 0.5s | 低 | 批量处理 |
| **RAG 检索** | 灵活 | 高 | 0.1s | 低 | 知识密集 |
| **混合策略** | 灵活 | 高 | 变化 | 中 | 通用 |

---

## 4. Sakura 推荐实现

### 4.1 设计原则

1. **阈值触发**：不是每次都压缩，超过阈值才触发
2. **渐进策略**：先用便宜方法，不够再用贵方法
3. **保护重要消息**：系统提示、最近消息始终保留
4. **可配置**：不同场景使用不同策略

### 4.2 核心类设计

```python
from dataclasses import dataclass, field
from typing import List, Literal, Optional, Callable
from abc import ABC, abstractmethod
from sakura.messages import Message

class CompressionStrategy(ABC):
    """压缩策略基类"""
    
    @abstractmethod
    def compress(self, messages: List[Message]) -> List[Message]:
        pass


class SlidingWindowStrategy(CompressionStrategy):
    """滑动窗口策略"""
    
    def __init__(self, window_size: int = 10, preserve_system: bool = True):
        self.window_size = window_size
        self.preserve_system = preserve_system
    
    def compress(self, messages: List[Message]) -> List[Message]:
        result = []
        
        # 保留系统消息
        if self.preserve_system and messages and messages[0].role == "system":
            result.append(messages[0])
            messages = messages[1:]
        
        # 保留最近 N 条
        result.extend(messages[-self.window_size:])
        return result


class SummaryStrategy(CompressionStrategy):
    """LLM 摘要策略"""
    
    def __init__(
        self,
        summarizer_model: str = "qwen-turbo",
        preserve_last: int = 5,
        summary_prompt: str = None
    ):
        self.summarizer_model = summarizer_model
        self.preserve_last = preserve_last
        self.summary_prompt = summary_prompt or self._default_prompt()
    
    def _default_prompt(self) -> str:
        return """请简明扼要地总结以下对话的关键信息：

{history}

总结要求：
1. 保留重要决策和结论
2. 保留关键数据和事实
3. 保留待办事项
4. 忽略寒暄和重复内容
5. 使用列表格式输出"""

    def compress(self, messages: List[Message]) -> List[Message]:
        from sakura import Agent
        
        # 分离消息
        system_msg = messages[0] if messages[0].role == "system" else None
        start_idx = 1 if system_msg else 0
        to_summarize = messages[start_idx:-self.preserve_last]
        recent = messages[-self.preserve_last:]
        
        if not to_summarize:
            return messages
        
        # 格式化历史
        history = "\n".join(
            f"{m.role}: {m.content[:500]}..." if len(m.content) > 500 else f"{m.role}: {m.content}"
            for m in to_summarize
        )
        
        # 生成摘要
        summarizer = Agent(model=self.summarizer_model)
        summary = summarizer.chat(self.summary_prompt.format(history=history))
        
        # 构建结果
        result = []
        if system_msg:
            result.append(system_msg)
        result.append(Message(
            role="system",
            content=f"[对话历史摘要]\n{summary}"
        ))
        result.extend(recent)
        
        return result


class HybridStrategy(CompressionStrategy):
    """混合策略：先滑动窗口，超限再摘要"""
    
    def __init__(
        self,
        window_size: int = 20,
        summary_threshold: int = 30,  # 超过这个数量才摘要
        summarizer_model: str = "qwen-turbo"
    ):
        self.window_strategy = SlidingWindowStrategy(window_size)
        self.summary_strategy = SummaryStrategy(summarizer_model)
        self.summary_threshold = summary_threshold
    
    def compress(self, messages: List[Message]) -> List[Message]:
        if len(messages) <= self.summary_threshold:
            return self.window_strategy.compress(messages)
        else:
            return self.summary_strategy.compress(messages)
```

### 4.3 SmartCompressor 主类

```python
@dataclass
class SmartCompressor:
    """智能上下文压缩器"""
    
    # 触发条件
    threshold: float = 0.85  # Token 使用率阈值
    min_messages: int = 10   # 最少消息数才触发
    
    # 策略配置
    strategy: Literal["sliding", "summary", "hybrid"] = "hybrid"
    
    # 策略参数
    window_size: int = 10
    preserve_last: int = 5
    summarizer_model: str = "qwen-turbo"
    
    # 内部
    _strategy_instance: CompressionStrategy = field(init=False, repr=False)
    
    # 模型上下文窗口（可扩展）
    _context_windows: dict = field(default_factory=lambda: {
        "qwen-plus": 131072,
        "qwen-turbo": 131072,
        "qwen-max": 32768,
        "gpt-4o": 128000,
        "gpt-4o-mini": 128000,
        "claude-3-5-sonnet": 200000,
        "claude-3-5-haiku": 200000,
    }, repr=False)
    
    def __post_init__(self):
        if self.strategy == "sliding":
            self._strategy_instance = SlidingWindowStrategy(self.window_size)
        elif self.strategy == "summary":
            self._strategy_instance = SummaryStrategy(
                self.summarizer_model, self.preserve_last
            )
        else:  # hybrid
            self._strategy_instance = HybridStrategy(
                self.window_size, 
                self.min_messages * 2,
                self.summarizer_model
            )
    
    def count_tokens(self, messages: List[Message]) -> int:
        """估算 Token 数量（简化版）"""
        # 实际应该使用 tiktoken 或模型特定的 tokenizer
        total = 0
        for m in messages:
            if m.content:
                # 粗略估计：1 中文字 ≈ 2 tokens, 1 英文词 ≈ 1.3 tokens
                total += len(m.content) * 0.7
        return int(total)
    
    def get_context_window(self, model_id: str) -> int:
        """获取模型上下文窗口大小"""
        for key, size in self._context_windows.items():
            if key in model_id.lower():
                return size
        return 128000  # 默认值
    
    def should_compress(self, messages: List[Message], model_id: str) -> bool:
        """判断是否需要压缩"""
        if len(messages) < self.min_messages:
            return False
        
        current_tokens = self.count_tokens(messages)
        max_tokens = self.get_context_window(model_id)
        usage_ratio = current_tokens / max_tokens
        
        return usage_ratio > self.threshold
    
    def compress(self, messages: List[Message]) -> List[Message]:
        """执行压缩"""
        return self._strategy_instance.compress(messages)
    
    def compress_if_needed(
        self, 
        messages: List[Message], 
        model_id: str
    ) -> tuple[List[Message], bool]:
        """检查并压缩（如果需要）"""
        if self.should_compress(messages, model_id):
            return self.compress(messages), True
        return messages, False
```

### 4.4 集成到 Agent

```python
# 在 Agent 中使用
@dataclass
class Agent:
    # ... 现有字段 ...
    compressor: Optional[SmartCompressor] = None
    
    def run(self, prompt: str, messages: List[Message] = None, **kwargs):
        # 压缩检查
        if self.compressor and messages:
            messages, compressed = self.compressor.compress_if_needed(
                messages, self._model.id
            )
            if compressed:
                log_info("Context compressed to fit window")
        
        # ... 现有逻辑 ...
```

### 4.5 使用示例

```python
from sakura import Agent
from sakura.memory import SmartCompressor

# 基本使用
agent = Agent(
    model="qwen-plus",
    tools=[...],
    compressor=SmartCompressor()  # 使用默认配置
)

# 自定义配置
agent = Agent(
    model="qwen-plus",
    tools=[...],
    compressor=SmartCompressor(
        threshold=0.80,          # 80% 使用率触发
        strategy="summary",      # 使用摘要策略
        preserve_last=10,        # 保留最近 10 条
        summarizer_model="qwen-turbo"  # 用便宜模型生成摘要
    )
)

# 纯滑动窗口（零成本）
agent = Agent(
    model="qwen-plus",
    tools=[...],
    compressor=SmartCompressor(
        strategy="sliding",
        window_size=20
    )
)
```

---

## 5. 进阶策略

### 5.1 重要性评分

```python
class ImportanceScorer:
    """消息重要性评分器"""
    
    def score(self, message: Message) -> float:
        score = 0.5  # 基础分
        
        # 工具调用更重要
        if message.tool_calls or message.tool_name:
            score += 0.3
        
        # 包含代码更重要
        if "```" in (message.content or ""):
            score += 0.2
        
        # 包含关键词更重要
        keywords = ["重要", "关键", "注意", "TODO", "FIXME"]
        if any(kw in (message.content or "") for kw in keywords):
            score += 0.2
        
        return min(1.0, score)
```

### 5.2 结构化历史保留

```python
class StructuredHistoryCompressor:
    """保留结构化历史"""
    
    def compress(self, messages: List[Message]) -> List[Message]:
        # 分类消息
        tool_results = []
        code_blocks = []
        decisions = []
        recent = []
        
        for m in messages:
            if m.role == "tool":
                tool_results.append(m)
            elif "```" in (m.content or ""):
                code_blocks.append(m)
            elif any(kw in (m.content or "") for kw in ["决定", "结论", "方案"]):
                decisions.append(m)
        
        recent = messages[-5:]
        
        # 构建压缩后的历史
        summary = f"""
[历史上下文]
- 工具调用: {len(tool_results)} 次
- 代码片段: {len(code_blocks)} 个
- 关键决策: {len(decisions)} 个

[关键决策摘要]
{self._summarize_decisions(decisions)}
"""
        
        return [
            Message(role="system", content=summary),
            *recent
        ]
```

---

## 6. 性能与成本分析

| 策略 | 额外延迟 | 额外成本 | 压缩效果 | 推荐场景 |
|------|----------|----------|----------|----------|
| 滑动窗口 | 0 | 0 | 一般 | 简单对话、成本敏感 |
| LLM 摘要 | 1-2s | ~0.01$ | 优秀 | 长对话、质量优先 |
| 混合策略 | 0-2s | 0-0.01$ | 优秀 | 通用推荐 |

### 成本优化建议

1. **延迟触发**：提高 threshold 到 0.9，减少压缩次数
2. **使用便宜模型**：摘要用 qwen-turbo 而非 qwen-plus
3. **缓存摘要**：相同历史生成相同摘要，可缓存
4. **批量压缩**：不是每轮都压缩，累积后一次压缩

---

## 7. 监控与调优

```python
class CompressorMetrics:
    """压缩器指标追踪"""
    
    def __init__(self):
        self.compressions = 0
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_latency = 0
    
    def record(self, input_tokens: int, output_tokens: int, latency: float):
        self.compressions += 1
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        self.total_latency += latency
    
    @property
    def avg_compression_ratio(self) -> float:
        if self.total_output_tokens == 0:
            return 0
        return self.total_input_tokens / self.total_output_tokens
    
    @property
    def avg_latency(self) -> float:
        if self.compressions == 0:
            return 0
        return self.total_latency / self.compressions
    
    def report(self) -> str:
        return f"""
压缩统计:
- 总压缩次数: {self.compressions}
- 平均压缩率: {self.avg_compression_ratio:.2f}x
- 平均延迟: {self.avg_latency:.2f}s
- 节省 Token: {self.total_input_tokens - self.total_output_tokens}
"""
```
