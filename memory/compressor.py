"""
Sakura Smart Compressor - 智能上下文压缩器

自动管理上下文压缩
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Tuple, TYPE_CHECKING

from .strategy import (
    CompressionStrategy,
    SlidingWindowStrategy,
    SummaryBufferStrategy,
    PriorityBasedStrategy,
)
from .validator import CompressionValidator
from ..utils.tokens import TokenCounter, get_context_window

if TYPE_CHECKING:
    from ..messages.message import Message


@dataclass
class CompressionMetrics:
    """
    压缩器指标追踪
    
    记录压缩操作的统计信息
    """
    compressions: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_latency: float = 0
    strategy_usage: Dict[str, int] = field(default_factory=dict)
    fallback_count: int = 0
    validation_failures: int = 0
    
    def record(
        self, 
        input_tokens: int, 
        output_tokens: int, 
        latency: float = 0,
        strategy: str = "",
        fallback: bool = False,
        validation_failed: bool = False
    ):
        """记录一次压缩操作"""
        self.compressions += 1
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        self.total_latency += latency
        
        if strategy:
            self.strategy_usage[strategy] = self.strategy_usage.get(strategy, 0) + 1
        
        if fallback:
            self.fallback_count += 1
        
        if validation_failed:
            self.validation_failures += 1
    
    @property
    def avg_compression_ratio(self) -> float:
        """平均压缩率"""
        if self.total_output_tokens == 0:
            return 0
        return self.total_input_tokens / self.total_output_tokens
    
    @property
    def avg_latency(self) -> float:
        """平均延迟"""
        if self.compressions == 0:
            return 0
        return self.total_latency / self.compressions
    
    @property
    def tokens_saved(self) -> int:
        """节省的 Token 数"""
        return self.total_input_tokens - self.total_output_tokens
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "compressions": self.compressions,
            "avg_compression_ratio": round(self.avg_compression_ratio, 2),
            "avg_latency_s": round(self.avg_latency, 3),
            "tokens_saved": self.tokens_saved,
            "strategy_usage": self.strategy_usage,
            "fallback_count": self.fallback_count,
            "validation_failures": self.validation_failures
        }
    
    def report(self) -> str:
        """生成报告"""
        return f"""压缩统计:
- 总压缩次数: {self.compressions}
- 平均压缩率: {self.avg_compression_ratio:.2f}x
- 平均延迟: {self.avg_latency:.3f}s
- 节省 Token: {self.tokens_saved:,}
- 策略分布: {self.strategy_usage}
- 降级次数: {self.fallback_count}
- 验证失败: {self.validation_failures}"""


@dataclass
class SmartCompressor:
    """
    智能上下文压缩器
    
    特性：
    - 阈值触发，避免过度压缩
    - 多策略支持，自动选择
    - 精确 Token 计数
    - 优雅降级处理
    - 压缩结果验证
    
    Example:
        compressor = SmartCompressor()
        
        # 检查并压缩（如果需要）
        messages, compressed, metadata = compressor.compress_if_needed(
            messages, model_id="qwen-plus"
        )
        
        # 强制压缩
        messages, metadata = compressor.compress(messages, model_id="qwen-plus")
    """
    
    # 触发条件
    threshold: float = 0.93      # Token 使用率阈值
    min_messages: int = 10       # 最少消息数才触发
    
    # 策略配置
    strategy: Literal["sliding", "summary", "summary_buffer", "priority", "auto"] = "auto"
    
    # 策略参数
    window_size: int = 10
    preserve_last: int = 5
    summarizer_model: str = "qwen-turbo"
    
    # 验证配置
    validate_result: bool = True
    
    # 指标追踪
    metrics: CompressionMetrics = field(default_factory=CompressionMetrics)
    
    def should_compress(
        self, 
        messages: List["Message"], 
        model_id: str
    ) -> bool:
        """
        判断是否需要压缩
        
        Args:
            messages: 消息列表
            model_id: 模型 ID
        
        Returns:
            是否需要压缩
        """
        if len(messages) < self.min_messages:
            return False
        
        current_tokens = TokenCounter.count_messages(messages, model_id)
        max_tokens = get_context_window(model_id, effective=True)
        usage_ratio = current_tokens / max_tokens
        
        return usage_ratio > self.threshold
    
    def _select_strategy(
        self, 
        messages: List["Message"], 
        model_id: str
    ) -> CompressionStrategy:
        """自动选择最佳策略"""
        if self.strategy != "auto":
            return self._create_strategy(self.strategy)
        
        # 根据消息数量和 Token 情况自动选择
        msg_count = len(messages)
        tokens = TokenCounter.count_messages(messages, model_id)
        
        if msg_count < 15:
            # 消息较少，使用滑动窗口
            return SlidingWindowStrategy(self.window_size)
        elif tokens > 8000:
            # Token 较多，使用摘要缓冲
            return SummaryBufferStrategy(
                preserve_last=self.preserve_last,
                summarizer_model=self.summarizer_model
            )
        else:
            # 中等情况，使用优先级策略
            return PriorityBasedStrategy(target_ratio=0.7)
    
    def _create_strategy(self, name: str) -> CompressionStrategy:
        """创建指定策略"""
        if name == "sliding":
            return SlidingWindowStrategy(self.window_size)
        elif name == "summary":
            return SummaryBufferStrategy(
                preserve_last=self.preserve_last,
                summarizer_model=self.summarizer_model
            )
        elif name == "summary_buffer":
            return SummaryBufferStrategy(
                preserve_last=self.preserve_last,
                summarizer_model=self.summarizer_model
            )
        elif name == "priority":
            return PriorityBasedStrategy()
        else:
            return SlidingWindowStrategy(self.window_size)
    
    def compress(
        self, 
        messages: List["Message"],
        model_id: str = "qwen-plus",
        target_tokens: Optional[int] = None
    ) -> Tuple[List["Message"], Dict[str, Any]]:
        """
        执行压缩
        
        Args:
            messages: 消息列表
            model_id: 模型 ID
            target_tokens: 目标 Token 数
        
        Returns:
            (压缩后的消息列表, 压缩元数据)
        """
        import time
        start_time = time.time()
        
        # 记录原始 Token 数
        input_tokens = TokenCounter.count_messages(messages, model_id)
        
        # 选择策略
        strategy = self._select_strategy(messages, model_id)
        
        # 执行压缩
        compressed, metadata = strategy.compress(messages, target_tokens, model_id)
        
        # 记录压缩后 Token 数
        output_tokens = TokenCounter.count_messages(compressed, model_id)
        
        # 验证结果
        validation_failed = False
        if self.validate_result:
            is_valid, warnings = CompressionValidator.validate(messages, compressed)
            metadata["validation"] = {
                "valid": is_valid,
                "warnings": warnings
            }
            validation_failed = not is_valid
        
        # 记录指标
        latency = time.time() - start_time
        self.metrics.record(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency=latency,
            strategy=metadata.get("strategy", ""),
            fallback=metadata.get("fallback", False),
            validation_failed=validation_failed
        )
        
        # 添加压缩信息到元数据
        metadata["input_tokens"] = input_tokens
        metadata["output_tokens"] = output_tokens
        metadata["compression_ratio"] = round(input_tokens / max(output_tokens, 1), 2)
        metadata["latency"] = round(latency, 3)
        
        return compressed, metadata
    
    def compress_if_needed(
        self, 
        messages: List["Message"], 
        model_id: str,
        target_tokens: Optional[int] = None
    ) -> Tuple[List["Message"], bool, Dict[str, Any]]:
        """
        检查并压缩（如果需要）
        
        Args:
            messages: 消息列表
            model_id: 模型 ID
            target_tokens: 目标 Token 数
        
        Returns:
            (消息列表, 是否执行了压缩, 元数据)
        """
        if self.should_compress(messages, model_id):
            compressed, metadata = self.compress(messages, model_id, target_tokens)
            return compressed, True, metadata
        
        return messages, False, {}
    
    def get_metrics(self) -> CompressionMetrics:
        """获取压缩指标"""
        return self.metrics
    
    def reset_metrics(self):
        """重置指标"""
        self.metrics = CompressionMetrics()
