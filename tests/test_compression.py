"""
Tests for Context Compression module
"""

import pytest
from typing import List

from sakura.messages.message import Message
from sakura.utils.tokens import TokenCounter, get_context_window, CONTEXT_WINDOWS
from sakura.memory.strategy import (
    SlidingWindowStrategy,
    SummaryBufferStrategy,
    PriorityBasedStrategy,
    MessagePriority,
    get_message_priority,
)
from sakura.memory.compressor import SmartCompressor, CompressionMetrics
from sakura.memory.validator import CompressionValidator


# ============ TokenCounter Tests ============

class TestTokenCounter:
    """TokenCounter 单元测试"""
    
    def test_count_empty_string(self):
        """测试空字符串"""
        assert TokenCounter.count("") == 0
        assert TokenCounter.count(None) == 0  # type: ignore
    
    def test_count_english_text(self):
        """测试英文文本"""
        text = "Hello, world!"
        count = TokenCounter.count(text)
        assert count > 0
        assert count < len(text)  # Token 数应小于字符数
    
    def test_count_chinese_text(self):
        """测试中文文本"""
        text = "你好，世界！"
        count = TokenCounter.count(text)
        assert count > 0
    
    def test_count_messages(self):
        """测试消息列表计数"""
        messages = [
            Message(role="system", content="You are helpful."),
            Message(role="user", content="Hello"),
            Message(role="assistant", content="Hi!"),
        ]
        count = TokenCounter.count_messages(messages)
        assert count > 0
        # 应该包含格式开销
        raw_count = sum(TokenCounter.count(m.content or "") for m in messages)
        assert count > raw_count
    
    def test_truncate_to_tokens(self):
        """测试截断功能"""
        text = "This is a long text that needs to be truncated to fit the token limit."
        max_tokens = 5
        truncated = TokenCounter.truncate_to_tokens(text, max_tokens)
        
        # 截断后应该更短
        assert len(truncated) < len(text)
        # 应该包含后缀
        assert truncated.endswith("...")


class TestContextWindows:
    """上下文窗口配置测试"""
    
    def test_known_models(self):
        """测试已知模型"""
        assert get_context_window("gpt-4o") > 0
        assert get_context_window("claude-3-5-sonnet") > 0
        assert get_context_window("qwen-plus") > 0
    
    def test_effective_vs_full(self):
        """测试有效窗口 vs 完整窗口"""
        effective = get_context_window("gpt-4o", effective=True)
        full = get_context_window("gpt-4o", effective=False)
        assert effective < full
    
    def test_unknown_model(self):
        """测试未知模型返回默认值"""
        window = get_context_window("unknown-model-xyz")
        assert window == 32000  # 默认有效窗口


# ============ Strategy Tests ============

class TestSlidingWindowStrategy:
    """滑动窗口策略测试"""
    
    def test_no_compression_needed(self):
        """测试不需要压缩的情况"""
        strategy = SlidingWindowStrategy(window_size=10)
        messages = [
            Message(role="user", content="Hello"),
            Message(role="assistant", content="Hi"),
        ]
        
        compressed, metadata = strategy.compress(messages)
        assert len(compressed) == len(messages)
        assert metadata["compressed"] == False
    
    def test_compress_old_messages(self):
        """测试压缩旧消息"""
        strategy = SlidingWindowStrategy(window_size=3)
        messages = [
            Message(role="system", content="System"),
            Message(role="user", content="Msg 1"),
            Message(role="assistant", content="Msg 2"),
            Message(role="user", content="Msg 3"),
            Message(role="assistant", content="Msg 4"),
            Message(role="user", content="Msg 5"),
        ]
        
        compressed, metadata = strategy.compress(messages)
        
        # 系统消息 + 最近 3 条
        assert len(compressed) == 4
        assert compressed[0].role == "system"
        assert metadata["removed_count"] > 0
    
    def test_preserve_system_message(self):
        """测试保留系统消息"""
        strategy = SlidingWindowStrategy(window_size=2, preserve_system=True)
        messages = [
            Message(role="system", content="System prompt"),
            Message(role="user", content="Msg 1"),
            Message(role="assistant", content="Msg 2"),
            Message(role="user", content="Msg 3"),
        ]
        
        compressed, _ = strategy.compress(messages)
        
        # 系统消息应该被保留
        assert compressed[0].role == "system"
        assert compressed[0].content == "System prompt"


class TestPriorityBasedStrategy:
    """优先级策略测试"""
    
    def test_priority_calculation(self):
        """测试优先级计算"""
        # 系统消息最高优先级
        sys_msg = Message(role="system", content="System")
        assert get_message_priority(sys_msg) == MessagePriority.CRITICAL.value
        
        # 包含代码的消息
        code_msg = Message(role="assistant", content="```python\nprint('hi')\n```")
        assert get_message_priority(code_msg) > MessagePriority.NORMAL.value
        
        # 包含关键词的消息
        important_msg = Message(role="user", content="这个很重要")
        assert get_message_priority(important_msg) > MessagePriority.NORMAL.value
    
    def test_compress_by_priority(self):
        """测试按优先级压缩"""
        strategy = PriorityBasedStrategy(target_ratio=0.5)
        messages = [
            Message(role="user", content="普通消息 1"),
            Message(role="assistant", content="普通消息 2"),
            Message(role="user", content="这个很重要！"),
            Message(role="assistant", content="普通消息 3"),
        ]
        
        compressed, metadata = strategy.compress(messages)
        
        # 应该保留重要消息
        contents = [m.content for m in compressed]
        assert any("重要" in c for c in contents if c)


# ============ Validator Tests ============

class TestCompressionValidator:
    """压缩验证器测试"""
    
    def test_valid_compression(self):
        """测试有效压缩"""
        original = [
            Message(role="system", content="System"),
            Message(role="user", content="Hello " * 100),
            Message(role="assistant", content="Hi " * 100),
            Message(role="user", content="Last message"),
        ]
        compressed = [
            Message(role="system", content="System"),
            Message(role="user", content="Last message"),
        ]
        
        is_valid, warnings = CompressionValidator.validate(original, compressed)
        # Token 应该减少
        assert "未减少" not in " ".join(warnings)
    
    def test_tool_pair_check(self):
        """测试工具配对检查"""
        messages = [
            Message(role="assistant", content="", tool_calls=[
                {"id": "call_1", "function": {"name": "test"}}
            ]),
            Message(role="tool", content="result", tool_call_id="call_1"),
        ]
        
        result = CompressionValidator.check_tool_pairs(messages)
        assert result["paired"] == 1
        assert len(result["orphan_results"]) == 0


# ============ SmartCompressor Tests ============

class TestSmartCompressor:
    """SmartCompressor 测试"""
    
    def test_should_not_compress_few_messages(self):
        """测试消息数量不足时不压缩"""
        compressor = SmartCompressor(min_messages=10)
        messages = [
            Message(role="user", content="Hello"),
            Message(role="assistant", content="Hi"),
        ]
        
        assert compressor.should_compress(messages, "gpt-4") == False
    
    def test_compress_if_needed(self):
        """测试按需压缩"""
        compressor = SmartCompressor(
            threshold=0.5,  # 低阈值方便测试
            min_messages=2,
            strategy="sliding",
            window_size=3
        )
        
        # 创建足够多的消息
        messages = [
            Message(role="user", content="Message " * 100)
            for _ in range(20)
        ]
        
        result, compressed, metadata = compressor.compress_if_needed(messages, "gpt-4")
        
        if compressed:
            assert len(result) < len(messages)
            assert "strategy" in metadata
    
    def test_metrics_tracking(self):
        """测试指标追踪"""
        compressor = SmartCompressor(
            threshold=0.1,
            min_messages=1,
            strategy="sliding"
        )
        
        messages = [Message(role="user", content="Test " * 50) for _ in range(5)]
        
        compressor.compress(messages, "gpt-4")
        
        metrics = compressor.get_metrics()
        assert metrics.compressions >= 1
        assert metrics.avg_compression_ratio >= 0
    
    def test_strategy_selection(self):
        """测试策略自动选择"""
        compressor = SmartCompressor(strategy="auto")
        
        # 少量消息应该选择滑动窗口
        small = [Message(role="user", content="Hi") for _ in range(5)]
        strategy = compressor._select_strategy(small, "gpt-4")
        assert isinstance(strategy, SlidingWindowStrategy)


class TestCompressionMetrics:
    """压缩指标测试"""
    
    def test_record_and_calculate(self):
        """测试记录和计算"""
        metrics = CompressionMetrics()
        
        metrics.record(
            input_tokens=1000,
            output_tokens=500,
            latency=0.5,
            strategy="sliding_window"
        )
        
        assert metrics.compressions == 1
        assert metrics.avg_compression_ratio == 2.0
        assert metrics.tokens_saved == 500
        assert metrics.avg_latency == 0.5
    
    def test_report(self):
        """测试报告生成"""
        metrics = CompressionMetrics()
        metrics.record(100, 50, 0.1, "test")
        
        report = metrics.report()
        assert "压缩统计" in report
        assert "压缩率" in report


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
