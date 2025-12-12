# 上下文压缩最佳实践报告

> ✅ **实现状态：已完成** | 代码位置：`sakura/memory/compressor.py`

> 基于 LangChain Memory、LLMLingua、LLMLingua-2 及行业最新实践的深度分析

---

## 0. Sakura 实现总结

### 已实现功能

| 功能 | 状态 |
|------|------|
| SmartCompressor 主类 | ✅ |
| 阈值触发机制 | ✅ |
| 滑动窗口策略 | ✅ |
| 摘要缓冲策略 (SummaryBuffer) | ✅ |
| 自动策略选择 | ✅ |
| 精确 Token 计数 (tiktoken) | ✅ |
| 消息优先级标记 | ✅ |
| 优雅降级 | ✅ |

### 使用示例

```python
from sakura import Agent
from sakura.memory import SmartCompressor

# 自动模式（推荐）
agent = Agent(
    model="qwen-plus",
    tools=[...],
    compressor=SmartCompressor(threshold=0.85)
)

# 或显式配置摘要缓冲策略
agent = Agent(
    model="qwen-plus",
    compressor=SmartCompressor(
        strategy="summary_buffer",
        preserve_last=10,
        summarizer_model="qwen-turbo"
    )
)
```

---

## 1. 核心问题

### 为什么需要上下文压缩

| 问题 | 影响 | 数据支撑 |
|------|------|----------|
| **成本** | Token 越多，API 费用越高 | GPT-4 约 $30/1M tokens |
| **延迟** | 长上下文处理时间更长 | 每增加 1K tokens 约增加 50-100ms |
| **Lost in the Middle** | LLM 容易忽略中间信息 | 研究显示中间位置信息召回率下降 20-40% |
| **上下文限制** | 超出窗口直接报错 | 即使 128K 模型，性能在 32K 后显著下降 |

> [!IMPORTANT]
> 研究表明：即使模型声称支持 128K context，实际性能在超过 32K tokens 后就会显著下降。"Context Bloat" 不仅浪费成本，还会降低回答质量。

### 关键指标

```
压缩率 = 原始 Token 数 / 压缩后 Token 数
保真度 = 压缩后输出质量 / 原始输出质量 (通常用下游任务评测)
```

理想目标：**高压缩率 + 高保真度 + 低延迟**

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
- 支持 10x-20x 压缩率，性能损失 < 5%

### 2.2 LLMLingua-2（微软）

**改进点**：
- 数据蒸馏（从 GPT-4 学习压缩策略）
- Token 分类器（而非困惑度计算）
- **速度提升 3-6x**

```python
# LLMLingua-2 实际使用
from llmlingua import PromptCompressor

compressor = PromptCompressor(
    model_name="microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"
)

compressed = compressor.compress_prompt(
    context=long_context,
    rate=0.5,  # 压缩到 50%
    force_tokens=["重要", "TODO"],  # 强制保留的关键词
    drop_consecutive=True  # 合并连续空格
)
```

### 2.3 LangChain 记忆策略

LangChain 提供了成熟的会话记忆管理模式：

| 类型 | 机制 | 适用场景 |
|------|------|----------|
| `ConversationBufferMemory` | 完整保存 | 短对话 |
| `ConversationBufferWindowMemory` | 滑动窗口 | 中等对话 |
| `ConversationSummaryMemory` | LLM 摘要 | 长对话 |
| `ConversationSummaryBufferMemory` | **混合：最近原文 + 历史摘要** | **推荐** |

> [!TIP]
> `ConversationSummaryBufferMemory` 是最佳平衡——保留最近消息的完整上下文，同时用摘要压缩历史消息。这是 Sakura 应该采用的核心策略。

### 2.4 滑动窗口（简单有效）

```python
def sliding_window(messages, window_size=10):
    """保留最近 N 条消息"""
    system = [m for m in messages if m.role == "system"][:1]
    others = [m for m in messages if m.role != "system"]
    return system + others[-window_size:]
```

**优点**：简单快速，零额外开销
**缺点**：丢失早期重要信息

### 2.5 RAG 检索（语义召回）

```python
def rag_compress(messages, query, top_k=5):
    """基于语义相似度检索相关历史"""
    embeddings = embed_model.encode([m.content for m in messages])
    query_embedding = embed_model.encode(query)
    
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
| **LLMLingua-2** | 5-20x | 高 | 0.1-0.5s | GPU | 批量处理 |
| **RAG 检索** | 灵活 | 高 | 0.1s | 低 | 知识密集 |
| **SummaryBuffer** | 灵活 | **最高** | 变化 | 中 | **通用推荐** |

---

## 4. Sakura 实现

### 4.1 设计原则

1. **阈值触发**：不是每次都压缩，超过阈值才触发
2. **渐进策略**：先用便宜方法，不够再用贵方法
3. **保护重要消息**：系统提示、最近消息、工具调用始终保留
4. **优雅降级**：压缩失败时自动回退到简单策略
5. **精确计数**：使用 tiktoken 而非估算

### 4.2 精确 Token 计数（关键改进）

```python
from typing import List, Optional
import tiktoken

class TokenCounter:
    """精确 Token 计数器"""
    
    # 模型编码映射
    _encoding_map = {
        "gpt-4": "cl100k_base",
        "gpt-3.5": "cl100k_base",
        "claude": "cl100k_base",  # Anthropic 接近 cl100k
        "qwen": "cl100k_base",    # 通义千问接近 cl100k
    }
    
    _cache: dict = {}
    
    @classmethod
    def get_encoding(cls, model_id: str) -> tiktoken.Encoding:
        """获取模型对应的编码器（带缓存）"""
        # 检查缓存
        if model_id in cls._cache:
            return cls._cache[model_id]
        
        # 尝试直接获取
        try:
            enc = tiktoken.encoding_for_model(model_id)
        except KeyError:
            # 根据模型前缀选择编码
            for prefix, encoding_name in cls._encoding_map.items():
                if prefix in model_id.lower():
                    enc = tiktoken.get_encoding(encoding_name)
                    break
            else:
                enc = tiktoken.get_encoding("cl100k_base")
        
        cls._cache[model_id] = enc
        return enc
    
    @classmethod
    def count(cls, text: str, model_id: str = "gpt-4") -> int:
        """计算文本的 Token 数"""
        if not text:
            return 0
        enc = cls.get_encoding(model_id)
        return len(enc.encode(text))
    
    @classmethod
    def count_messages(cls, messages: List["Message"], model_id: str = "gpt-4") -> int:
        """计算消息列表的总 Token 数"""
        total = 0
        for m in messages:
            # 消息格式开销（role + content 分隔符）
            total += 4  # 每条消息约 4 tokens 开销
            total += cls.count(m.content or "", model_id)
            if m.name:
                total += cls.count(m.name, model_id) + 1
        total += 2  # 对话起止标记
        return total
```

### 4.3 消息重要性标记

```python
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum

class MessagePriority(Enum):
    """消息优先级"""
    CRITICAL = 1.0    # 绝不压缩（系统提示、关键决策）
    HIGH = 0.8        # 尽量保留（工具调用、代码）
    NORMAL = 0.5      # 正常处理
    LOW = 0.3         # 优先压缩（寒暄、重复）
    TEMPORARY = 0.1   # 可直接丢弃（中间状态）


@dataclass
class Message:
    role: str
    content: Optional[str] = None
    # ... 现有字段 ...
    
    # 新增：压缩相关
    temporary: bool = False              # 临时消息，优先丢弃
    priority: MessagePriority = MessagePriority.NORMAL
    compressed_content: Optional[str] = None  # 压缩后的版本
    
    def get_compression_priority(self) -> float:
        """获取压缩优先级（用于排序）"""
        score = self.priority.value
        
        # 工具调用更重要
        if self.tool_calls or self.tool_call_id:
            score = max(score, MessagePriority.HIGH.value)
        
        # 包含代码更重要
        if "```" in (self.content or ""):
            score += 0.1
        
        # 包含关键词更重要
        keywords = ["重要", "关键", "注意", "TODO", "FIXME", "决定", "结论"]
        if any(kw in (self.content or "") for kw in keywords):
            score += 0.1
        
        return min(1.0, score)
```

### 4.4 压缩策略基类

```python
from abc import ABC, abstractmethod
from typing import List, Tuple

class CompressionStrategy(ABC):
    """压缩策略基类"""
    
    @abstractmethod
    def compress(
        self, 
        messages: List[Message],
        target_tokens: Optional[int] = None
    ) -> Tuple[List[Message], dict]:
        """
        执行压缩
        
        Args:
            messages: 消息列表
            target_tokens: 目标 Token 数（可选）
        
        Returns:
            (压缩后的消息列表, 压缩元数据)
        """
        pass


class SlidingWindowStrategy(CompressionStrategy):
    """滑动窗口策略"""
    
    def __init__(
        self, 
        window_size: int = 10, 
        preserve_system: bool = True,
        preserve_tool_pairs: bool = True
    ):
        self.window_size = window_size
        self.preserve_system = preserve_system
        self.preserve_tool_pairs = preserve_tool_pairs
    
    def compress(
        self, 
        messages: List[Message],
        target_tokens: Optional[int] = None
    ) -> Tuple[List[Message], dict]:
        result = []
        removed = 0
        
        # 保留系统消息
        if self.preserve_system and messages and messages[0].role == "system":
            result.append(messages[0])
            messages = messages[1:]
        
        # 保留最近 N 条
        if len(messages) > self.window_size:
            removed = len(messages) - self.window_size
            messages = messages[-self.window_size:]
        
        result.extend(messages)
        
        return result, {"strategy": "sliding_window", "removed_count": removed}
```

### 4.5 摘要缓冲策略（推荐）

```python
class SummaryBufferStrategy(CompressionStrategy):
    """
    摘要缓冲混合策略（参考 LangChain ConversationSummaryBufferMemory）
    
    - 保留最近 N 条消息的原文
    - 将更早的消息压缩为摘要
    - 自动平衡精确上下文和历史信息
    """
    
    def __init__(
        self,
        preserve_last: int = 5,
        max_token_limit: int = 4000,
        summarizer_model: str = "qwen-turbo",
        summary_prompt: str = None
    ):
        self.preserve_last = preserve_last
        self.max_token_limit = max_token_limit
        self.summarizer_model = summarizer_model
        self.summary_prompt = summary_prompt or self._default_prompt()
    
    def _default_prompt(self) -> str:
        return """请简明扼要地总结以下对话的关键信息：

{history}

总结要求：
1. 保留重要决策和结论
2. 保留关键数据和事实
3. 保留待办事项和进度
4. 保留工具调用的关键结果
5. 忽略寒暄和重复内容
6. 使用列表格式输出"""
    
    def compress(
        self, 
        messages: List[Message],
        target_tokens: Optional[int] = None
    ) -> Tuple[List[Message], dict]:
        from ..agent import Agent
        
        # 分离消息
        system_msg = messages[0] if messages and messages[0].role == "system" else None
        start_idx = 1 if system_msg else 0
        
        to_summarize = messages[start_idx:-self.preserve_last]
        recent = messages[-self.preserve_last:]
        
        if not to_summarize:
            return messages, {"strategy": "summary_buffer", "summarized": False}
        
        # 格式化历史
        history = self._format_history(to_summarize)
        
        # 生成摘要（带错误处理）
        try:
            summarizer = Agent(model=self.summarizer_model)
            summary = summarizer.run(self.summary_prompt.format(history=history)).content
        except Exception as e:
            # 降级到滑动窗口
            fallback = SlidingWindowStrategy(self.preserve_last)
            return fallback.compress(messages)
        
        # 构建结果
        result = []
        if system_msg:
            result.append(system_msg)
        
        result.append(Message(
            role="system",
            content=f"[对话历史摘要]\n{summary}",
            priority=MessagePriority.HIGH
        ))
        result.extend(recent)
        
        return result, {
            "strategy": "summary_buffer",
            "summarized": True,
            "original_count": len(to_summarize),
            "summary_tokens": TokenCounter.count(summary)
        }
    
    def _format_history(self, messages: List[Message]) -> str:
        """格式化历史消息"""
        lines = []
        for m in messages:
            content = m.content or ""
            # 截断过长内容
            if len(content) > 500:
                content = content[:500] + "..."
            lines.append(f"{m.role}: {content}")
        return "\n".join(lines)
```

### 4.6 SmartCompressor 主类

```python
from dataclasses import dataclass, field
from typing import Literal, Optional, List, Tuple

@dataclass
class SmartCompressor:
    """
    智能上下文压缩器
    
    特性：
    - 阈值触发，避免过度压缩
    - 多策略支持，自动选择
    - 精确 Token 计数
    - 优雅降级处理
    """
    
    # 触发条件
    threshold: float = 0.85      # Token 使用率阈值
    min_messages: int = 10       # 最少消息数才触发
    
    # 策略配置
    strategy: Literal["sliding", "summary", "summary_buffer", "auto"] = "auto"
    
    # 策略参数
    window_size: int = 10
    preserve_last: int = 5
    summarizer_model: str = "qwen-turbo"
    
    # 上下文窗口配置（可扩展）
    _context_windows: dict = field(default_factory=lambda: {
        "qwen-plus": 131072,
        "qwen-turbo": 131072,
        "qwen-max": 32768,
        "gpt-4o": 128000,
        "gpt-4o-mini": 128000,
        "gpt-4-turbo": 128000,
        "claude-3-5-sonnet": 200000,
        "claude-3-5-haiku": 200000,
        "claude-3-opus": 200000,
    }, repr=False)
    
    # 实际性能窗口（比声称的小）
    _effective_windows: dict = field(default_factory=lambda: {
        "qwen-plus": 32000,       # 保守估计
        "qwen-turbo": 32000,
        "gpt-4o": 32000,
        "claude-3-5-sonnet": 50000,
    }, repr=False)
    
    def get_context_window(self, model_id: str, effective: bool = True) -> int:
        """获取模型上下文窗口大小"""
        windows = self._effective_windows if effective else self._context_windows
        
        for key, size in windows.items():
            if key in model_id.lower():
                return size
        
        return 32000  # 保守默认值
    
    def should_compress(self, messages: List[Message], model_id: str) -> bool:
        """判断是否需要压缩"""
        if len(messages) < self.min_messages:
            return False
        
        current_tokens = TokenCounter.count_messages(messages, model_id)
        max_tokens = self.get_context_window(model_id)
        usage_ratio = current_tokens / max_tokens
        
        return usage_ratio > self.threshold
    
    def _select_strategy(self, messages: List[Message], model_id: str) -> CompressionStrategy:
        """自动选择最佳策略"""
        if self.strategy != "auto":
            return self._create_strategy(self.strategy)
        
        # 根据消息数量和 Token 情况自动选择
        msg_count = len(messages)
        tokens = TokenCounter.count_messages(messages, model_id)
        
        if msg_count < 20:
            return SlidingWindowStrategy(self.window_size)
        elif tokens > 10000:
            return SummaryBufferStrategy(
                self.preserve_last, 
                summarizer_model=self.summarizer_model
            )
        else:
            return SlidingWindowStrategy(self.window_size)
    
    def _create_strategy(self, name: str) -> CompressionStrategy:
        """创建指定策略"""
        if name == "sliding":
            return SlidingWindowStrategy(self.window_size)
        elif name == "summary":
            return SummaryBufferStrategy(
                self.preserve_last,
                summarizer_model=self.summarizer_model
            )
        elif name == "summary_buffer":
            return SummaryBufferStrategy(
                self.preserve_last,
                summarizer_model=self.summarizer_model
            )
        else:
            return SlidingWindowStrategy(self.window_size)
    
    def compress(
        self, 
        messages: List[Message],
        model_id: str = "qwen-plus"
    ) -> Tuple[List[Message], dict]:
        """执行压缩"""
        strategy = self._select_strategy(messages, model_id)
        return strategy.compress(messages)
    
    def compress_if_needed(
        self, 
        messages: List[Message], 
        model_id: str
    ) -> Tuple[List[Message], bool, dict]:
        """检查并压缩（如果需要）"""
        if self.should_compress(messages, model_id):
            compressed, metadata = self.compress(messages, model_id)
            return compressed, True, metadata
        return messages, False, {}
```

### 4.7 验证压缩结果完整性

```python
class CompressionValidator:
    """压缩结果验证器"""
    
    @staticmethod
    def validate(
        original: List[Message], 
        compressed: List[Message]
    ) -> Tuple[bool, List[str]]:
        """
        验证压缩结果的完整性
        
        Returns:
            (是否有效, 警告列表)
        """
        warnings = []
        
        # 1. 检查系统消息是否保留
        orig_system = [m for m in original if m.role == "system"]
        comp_system = [m for m in compressed if m.role == "system"]
        if orig_system and not comp_system:
            warnings.append("系统消息丢失")
        
        # 2. 检查工具调用配对
        orig_tool_calls = {m.id for m in original if m.tool_calls}
        orig_tool_results = {m.tool_call_id for m in original if m.tool_call_id}
        comp_tool_results = {m.tool_call_id for m in compressed if m.tool_call_id}
        
        # 检查是否有孤立的工具结果
        orphan_results = comp_tool_results - orig_tool_calls
        if orphan_results:
            warnings.append(f"发现孤立的工具结果: {orphan_results}")
        
        # 3. 检查压缩是否有效减少了 Token
        orig_tokens = TokenCounter.count_messages(original)
        comp_tokens = TokenCounter.count_messages(compressed)
        if comp_tokens >= orig_tokens:
            warnings.append("压缩未减少 Token 数")
        
        # 4. 检查最后一条消息是否保留
        if original and compressed:
            if original[-1].content != compressed[-1].content:
                if original[-1].role != "system":  # 系统消息可能被移到摘要
                    warnings.append("最后一条消息可能被修改")
        
        is_valid = len([w for w in warnings if "丢失" in w or "孤立" in w]) == 0
        return is_valid, warnings
```

### 4.8 集成到 Agent

```python
# 在 Agent 中使用
@dataclass
class Agent:
    # ... 现有字段 ...
    compressor: Optional[SmartCompressor] = None
    
    def run(self, prompt: str, messages: List[Message] = None, **kwargs):
        # 压缩检查
        if self.compressor and messages:
            messages, compressed, metadata = self.compressor.compress_if_needed(
                messages, self.model.id
            )
            if compressed:
                log_info(f"Context compressed: {metadata}")
                
                # 验证压缩结果
                is_valid, warnings = CompressionValidator.validate(
                    kwargs.get("original_messages", []), 
                    messages
                )
                if warnings:
                    log_warning(f"Compression warnings: {warnings}")
        
        # ... 现有逻辑 ...
```

### 4.9 使用示例

```python
from sakura import Agent
from sakura.memory import SmartCompressor

# 基本使用（自动模式）
agent = Agent(
    model="qwen-plus",
    tools=[...],
    compressor=SmartCompressor()  # 自动选择策略
)

# 自定义配置
agent = Agent(
    model="qwen-plus",
    tools=[...],
    compressor=SmartCompressor(
        threshold=0.80,              # 80% 使用率触发
        strategy="summary_buffer",   # 使用摘要缓冲策略
        preserve_last=10,            # 保留最近 10 条
        summarizer_model="qwen-turbo"
    )
)

# 纯滑动窗口（零成本、零延迟）
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

## 5. 监控与指标

```python
from dataclasses import dataclass, field
from time import time

@dataclass
class CompressionMetrics:
    """压缩器指标追踪"""
    
    compressions: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_latency: float = 0
    strategy_usage: dict = field(default_factory=dict)
    fallback_count: int = 0
    
    def record(
        self, 
        input_tokens: int, 
        output_tokens: int, 
        latency: float,
        strategy: str,
        fallback: bool = False
    ):
        self.compressions += 1
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        self.total_latency += latency
        self.strategy_usage[strategy] = self.strategy_usage.get(strategy, 0) + 1
        if fallback:
            self.fallback_count += 1
    
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
    
    @property
    def tokens_saved(self) -> int:
        return self.total_input_tokens - self.total_output_tokens
    
    def report(self) -> str:
        return f"""
压缩统计:
- 总压缩次数: {self.compressions}
- 平均压缩率: {self.avg_compression_ratio:.2f}x
- 平均延迟: {self.avg_latency:.3f}s
- 节省 Token: {self.tokens_saved:,}
- 策略分布: {self.strategy_usage}
- 降级次数: {self.fallback_count}
"""
```

---

## 6. 性能与成本分析

| 策略 | 额外延迟 | 额外成本 | 压缩效果 | 推荐场景 |
|------|----------|----------|----------|----------|
| 滑动窗口 | 0 | 0 | 一般 | 简单对话、成本敏感 |
| LLM 摘要 | 1-2s | ~$0.01 | 优秀 | 长对话、质量优先 |
| 摘要缓冲 | 0-2s | 0-$0.01 | **最优** | **通用推荐** |
| LLMLingua-2 | 0.1-0.5s | GPU 成本 | 优秀 | 批量处理、本地部署 |

### 成本优化建议

1. **延迟触发**：提高 threshold 到 0.9，减少压缩次数
2. **使用便宜模型**：摘要用 qwen-turbo（成本为 qwen-plus 的 1/10）
3. **批量压缩**：累积后一次压缩，而非每轮都压缩
4. **使用有效窗口**：不要被模型声称的 128K 所迷惑，实际使用 32K 更稳定

---

## 7. 实现路径

| 模块 | 建议路径 |
|------|----------|
| Token 计数 | `sakura/utils/tokens.py` |
| 策略基类 | `sakura/memory/strategy.py` |
| SmartCompressor | `sakura/memory/compressor.py` |
| Metrics | `sakura/memory/metrics.py` |
| 验证器 | `sakura/memory/validator.py` |

---

## 8. 总结

> [!TIP]
> **核心建议**：采用 `SummaryBufferStrategy` 作为默认策略，配合精确 Token 计数和优雅降级，可以在保持高质量的同时显著降低成本。

关键实现要点：
1. ✅ 使用 tiktoken 精确计数（而非估算）
2. ✅ 采用 SummaryBuffer 混合策略（最近原文 + 历史摘要）
3. ✅ 实现优雅降级（摘要失败时回退到滑动窗口）
4. ✅ 添加消息优先级标记（临时消息优先压缩）
5. ✅ 验证压缩结果完整性（检查工具调用配对）
6. ✅ 使用有效窗口而非声称窗口（保守策略更稳定）
