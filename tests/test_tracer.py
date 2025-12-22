"""
Tests for Monitor Tracer module

测试 FlowTracer, TraceSpan, @trace_flow 装饰器
这些测试不需要 API，使用模拟数据
"""

import pytest
import asyncio
import time
import tempfile
import os
from pathlib import Path

from sakura.monitor import (
    FlowTracer,
    TraceSpan,
    trace_flow,
    trace_span,
    trace_event,
)


class TestTraceSpan:
    """TraceSpan 数据类测试"""
    
    def test_span_creation(self):
        """测试创建 Span"""
        span = TraceSpan(name="test_span", span_type="tool")
        
        assert span.name == "test_span"
        assert span.span_type == "tool"
        assert span.status == "running"
        assert span.end_time is None
    
    def test_span_finish(self):
        """测试 Span 完成"""
        span = TraceSpan(name="test")
        time.sleep(0.1)
        span.finish(status="success")
        
        assert span.status == "success"
        assert span.end_time is not None
        assert span.duration >= 0.1
    
    def test_span_finish_with_error(self):
        """测试 Span 错误完成"""
        span = TraceSpan(name="test")
        span.finish(status="error", error="Something went wrong")
        
        assert span.status == "error"
        assert span.error == "Something went wrong"
    
    def test_span_add_metadata(self):
        """测试添加元数据"""
        span = TraceSpan(name="test")
        span.add_metadata(model="qwen-plus", tokens=100)
        
        assert span.metadata["model"] == "qwen-plus"
        assert span.metadata["tokens"] == 100
    
    def test_span_duration_running(self):
        """测试运行中的 Span 时长"""
        span = TraceSpan(name="test")
        time.sleep(0.05)
        
        # 运行中的 span 应该有正的时长
        assert span.duration > 0
    
    def test_span_id_unique(self):
        """测试 Span ID 唯一性"""
        span1 = TraceSpan(name="test1")
        span2 = TraceSpan(name="test2")
        
        assert span1.span_id != span2.span_id


class TestFlowTracer:
    """FlowTracer 上下文管理器测试"""
    
    def test_tracer_context_manager(self):
        """测试作为上下文管理器"""
        with FlowTracer(name="test_trace") as tracer:
            assert tracer.root_span is not None
            assert tracer.root_span.name == "test_trace"
        
        assert tracer.root_span.status == "success"
        assert tracer.root_span.end_time is not None
    
    def test_tracer_nested_spans(self):
        """测试嵌套 Span"""
        with FlowTracer(name="root") as tracer:
            with tracer.span("level1", span_type="agent"):
                with tracer.span("level2", span_type="tool"):
                    pass
        
        # 验证层级结构
        assert len(tracer.root_span.children) == 1
        level1 = tracer.root_span.children[0]
        assert level1.name == "level1"
        assert len(level1.children) == 1
        assert level1.children[0].name == "level2"
    
    def test_tracer_add_event(self):
        """测试添加事件"""
        with FlowTracer(name="root") as tracer:
            tracer.add_event("event1", span_type="llm", tokens=500)
        
        assert len(tracer.root_span.children) == 1
        event = tracer.root_span.children[0]
        assert event.name == "event1"
        assert event.metadata["tokens"] == 500
    
    def test_tracer_get_current(self):
        """测试获取当前 tracer"""
        assert FlowTracer.get_current() is None
        
        with FlowTracer(name="test") as tracer:
            current = FlowTracer.get_current()
            assert current is tracer
        
        assert FlowTracer.get_current() is None
    
    def test_tracer_error_handling(self):
        """测试错误处理"""
        try:
            with FlowTracer(name="test") as tracer:
                raise ValueError("Test error")
        except ValueError:
            pass
        
        assert tracer.root_span.status == "error"
        assert "Test error" in tracer.root_span.error


class TestFlowTracerOutput:
    """FlowTracer 输出测试"""
    
    def test_to_mermaid(self):
        """测试生成 Mermaid 代码"""
        with FlowTracer(name="test") as tracer:
            with tracer.span("agent", span_type="agent"):
                tracer.add_event("tool_call", span_type="tool")
        
        mermaid = tracer.to_mermaid()
        
        assert "```mermaid" in mermaid
        assert "flowchart TB" in mermaid
        assert "```" in mermaid
    
    def test_to_html(self):
        """测试生成 HTML"""
        with FlowTracer(name="test") as tracer:
            with tracer.span("agent", span_type="agent", model="qwen-plus"):
                pass
        
        html = tracer.to_html()
        
        assert "<!DOCTYPE html>" in html
        assert "mermaid" in html
        assert "Agent Execution Flow" in html
    
    def test_save_html(self, tmp_path):
        """测试保存 HTML 文件"""
        filepath = tmp_path / "trace.html"
        
        with FlowTracer(name="test") as tracer:
            with tracer.span("agent", span_type="agent"):
                pass
            tracer.save(str(filepath))
        
        assert filepath.exists()
        content = filepath.read_text()
        assert "<!DOCTYPE html>" in content
    
    def test_save_mermaid(self, tmp_path):
        """测试保存 Mermaid 文件"""
        filepath = tmp_path / "trace.md"
        
        with FlowTracer(name="test") as tracer:
            with tracer.span("agent", span_type="agent"):
                pass
            tracer.save(str(filepath))
        
        assert filepath.exists()
        content = filepath.read_text()
        assert "```mermaid" in content


class TestTraceFlowDecorator:
    """@trace_flow 装饰器测试"""
    
    def test_sync_function(self):
        """测试同步函数装饰"""
        @trace_flow(print_trace=False)
        def my_func():
            return "result"
        
        result = my_func()
        assert result == "result"
    
    @pytest.mark.asyncio
    async def test_async_function(self):
        """测试异步函数装饰"""
        @trace_flow(print_trace=False)
        async def my_async_func():
            await asyncio.sleep(0.01)
            return "async_result"
        
        result = await my_async_func()
        assert result == "async_result"
    
    def test_with_output_file(self, tmp_path):
        """测试输出到文件"""
        filepath = tmp_path / "decorated_trace.html"
        
        @trace_flow(output_file=str(filepath), print_trace=False)
        def my_func():
            return "done"
        
        my_func()
        
        assert filepath.exists()
    
    def test_with_custom_name(self):
        """测试自定义名称"""
        captured_name = None
        
        @trace_flow(name="custom_trace", print_trace=False)
        def my_func():
            tracer = FlowTracer.get_current()
            nonlocal captured_name
            captured_name = tracer.root_span.name
            return "done"
        
        my_func()
        assert captured_name == "custom_trace"
    
    def test_nested_spans_in_decorated(self):
        """测试装饰函数内使用 trace_span"""
        spans_created = []
        
        @trace_flow(print_trace=False)
        def my_func():
            with trace_span("inner_span", span_type="tool"):
                spans_created.append("inner_span")
            return "done"
        
        my_func()
        assert "inner_span" in spans_created


class TestTraceSpanHelper:
    """trace_span 辅助函数测试"""
    
    def test_trace_span_with_tracer(self):
        """测试有 tracer 时的 trace_span"""
        with FlowTracer(name="root") as tracer:
            with trace_span("helper_span", span_type="tool", custom_arg="value"):
                pass
        
        assert len(tracer.root_span.children) == 1
        span = tracer.root_span.children[0]
        assert span.name == "helper_span"
        assert span.metadata["custom_arg"] == "value"
    
    def test_trace_span_without_tracer(self):
        """测试无 tracer 时的 trace_span（不崩溃）"""
        # 应该不抛出异常
        with trace_span("orphan_span", span_type="tool"):
            pass


class TestTraceEventHelper:
    """trace_event 辅助函数测试"""
    
    def test_trace_event_with_tracer(self):
        """测试有 tracer 时的 trace_event"""
        with FlowTracer(name="root") as tracer:
            trace_event("my_event", span_type="llm", tokens=100)
        
        assert len(tracer.root_span.children) == 1
        event = tracer.root_span.children[0]
        assert event.name == "my_event"
        assert event.metadata["tokens"] == 100
    
    def test_trace_event_without_tracer(self):
        """测试无 tracer 时的 trace_event"""
        result = trace_event("orphan_event")
        assert result is None


class TestTracerMetadata:
    """测试元数据传递"""
    
    def test_agent_metadata(self):
        """测试 Agent 类型元数据"""
        with FlowTracer(name="root") as tracer:
            with tracer.span(
                "main_agent",
                span_type="agent",
                model="qwen-plus",
                tools=["search", "calculate"],
                system_prompt="You are helpful",
                user_prompt="Do something"
            ):
                pass
        
        span = tracer.root_span.children[0]
        assert span.metadata["model"] == "qwen-plus"
        assert span.metadata["tools"] == ["search", "calculate"]
        assert span.metadata["system_prompt"] == "You are helpful"
        assert span.metadata["user_prompt"] == "Do something"
    
    def test_tool_metadata(self):
        """测试 Tool 类型元数据"""
        with FlowTracer(name="root") as tracer:
            with tracer.span(
                "web_search",
                span_type="tool",
                args="python tutorial",
                result="Found 10 results..."
            ):
                pass
        
        span = tracer.root_span.children[0]
        assert span.metadata["args"] == "python tutorial"
        assert span.metadata["result"] == "Found 10 results..."
    
    def test_llm_metadata(self):
        """测试 LLM 类型元数据"""
        with FlowTracer(name="root") as tracer:
            tracer.add_event(
                "LLM 调用",
                span_type="llm",
                tokens=1500,
                input_tokens=500,
                output_tokens=1000
            )
        
        event = tracer.root_span.children[0]
        assert event.metadata["tokens"] == 1500
        assert event.metadata["input_tokens"] == 500
        assert event.metadata["output_tokens"] == 1000


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
