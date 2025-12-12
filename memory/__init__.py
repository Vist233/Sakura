"""
Sakura Memory - 上下文记忆管理

提供上下文压缩和记忆管理功能

Usage:
    from sakura.memory import SmartCompressor
    
    compressor = SmartCompressor(
        threshold=0.85,
        strategy="auto"
    )
    
    messages, compressed, metadata = compressor.compress_if_needed(
        messages, model_id="qwen-plus"
    )
"""

from .compressor import SmartCompressor, CompressionMetrics
from .strategy import (
    CompressionStrategy,
    SlidingWindowStrategy,
    SummaryBufferStrategy,
    PriorityBasedStrategy,
    MessagePriority,
    get_message_priority,
)
from .validator import CompressionValidator

__all__ = [
    # 主类
    "SmartCompressor",
    "CompressionMetrics",
    
    # 策略
    "CompressionStrategy",
    "SlidingWindowStrategy",
    "SummaryBufferStrategy",
    "PriorityBasedStrategy",
    
    # 优先级
    "MessagePriority",
    "get_message_priority",
    
    # 验证
    "CompressionValidator",
]
