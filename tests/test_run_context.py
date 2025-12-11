"""
Tests for RunContext and related classes

测试运行上下文和相关类
"""

import pytest

from sakura.run import (
    RunState,
    RunContext,
    RunOutput,
    RunContentEvent,
    RunOutputEvent,
    CustomEvent,
    RunRequirement,
    TeamRunOutput,
    ToolResult,
)


class TestRunState:
    """RunState 枚举测试"""
    
    def test_run_state_values(self):
        """测试运行状态值"""
        assert RunState.PENDING.value == "pending"
        assert RunState.RUNNING.value == "running"
        assert RunState.COMPLETED.value == "completed"
        assert RunState.FAILED.value == "failed"
        assert RunState.CANCELLED.value == "cancelled"
    
    def test_run_state_is_string_enum(self):
        """测试是字符串枚举"""
        assert isinstance(RunState.PENDING, str)
        assert RunState.RUNNING == "running"


class TestRunContext:
    """RunContext 测试"""
    
    def test_run_context_creation_default(self):
        """测试默认创建"""
        ctx = RunContext()
        
        assert ctx.run_id is None
        assert ctx.session_id is None
        assert ctx.user_id is None
        assert ctx.state == RunState.PENDING
        assert ctx.session_state == {}
        assert ctx.run_data == {}
    
    def test_run_context_creation_with_values(self, sample_run_context):
        """测试带值创建"""
        assert sample_run_context.run_id == "test-run-123"
        assert sample_run_context.session_id == "session-456"
        assert sample_run_context.user_id == "user-789"
        assert sample_run_context.state == RunState.RUNNING
    
    def test_run_context_get(self, sample_run_context):
        """测试获取状态值"""
        assert sample_run_context.get("key") == "value"
        assert sample_run_context.get("nonexistent") is None
        assert sample_run_context.get("missing", "default") == "default"
    
    def test_run_context_set(self):
        """测试设置状态值"""
        ctx = RunContext()
        
        ctx.set("new_key", "new_value")
        
        assert ctx.get("new_key") == "new_value"
        assert ctx.session_state["new_key"] == "new_value"
    
    def test_run_context_update(self):
        """测试批量更新状态"""
        ctx = RunContext()
        
        ctx.update({"key1": "val1", "key2": "val2"})
        
        assert ctx.get("key1") == "val1"
        assert ctx.get("key2") == "val2"
    
    def test_run_context_with_dependencies(self):
        """测试依赖注入"""
        ctx = RunContext(
            dependencies={"db": "database_client", "cache": "redis_client"}
        )
        
        assert ctx.dependencies["db"] == "database_client"
        assert ctx.dependencies["cache"] == "redis_client"
    
    def test_run_context_with_metadata(self):
        """测试元数据"""
        ctx = RunContext(
            metadata={"request_id": "req-123", "timestamp": "2024-01-01"}
        )
        
        assert ctx.metadata["request_id"] == "req-123"


class TestRunOutput:
    """RunOutput 测试"""
    
    def test_run_output_creation_default(self):
        """测试默认创建"""
        output = RunOutput()
        
        assert output.content is None
        assert output.structured_output is None
        assert output.state == RunState.COMPLETED
        assert output.error is None
    
    def test_run_output_with_content(self):
        """测试带内容创建"""
        output = RunOutput(
            content="Task completed successfully",
            state=RunState.COMPLETED
        )
        
        assert output.content == "Task completed successfully"
    
    def test_run_output_with_error(self):
        """测试带错误创建"""
        output = RunOutput(
            state=RunState.FAILED,
            error="Something went wrong"
        )
        
        assert output.state == RunState.FAILED
        assert output.error == "Something went wrong"
    
    def test_run_output_with_structured_output(self):
        """测试结构化输出"""
        output = RunOutput(
            structured_output={"result": "success", "data": [1, 2, 3]}
        )
        
        assert output.structured_output["result"] == "success"
    
    def test_run_output_with_metadata(self):
        """测试元数据"""
        output = RunOutput(
            content="Done",
            metadata={"duration_ms": 150, "tokens_used": 100}
        )
        
        assert output.metadata["duration_ms"] == 150


class TestRunContentEvent:
    """RunContentEvent 枚举测试"""
    
    def test_event_types(self):
        """测试事件类型"""
        assert RunContentEvent.CONTENT.value == "content"
        assert RunContentEvent.TOOL_CALL.value == "tool_call"
        assert RunContentEvent.TOOL_RESULT.value == "tool_result"
        assert RunContentEvent.ERROR.value == "error"


class TestRunOutputEvent:
    """RunOutputEvent 测试"""
    
    def test_content_event(self):
        """测试内容事件"""
        event = RunOutputEvent(
            event_type=RunContentEvent.CONTENT,
            content="Hello, world!"
        )
        
        assert event.event_type == RunContentEvent.CONTENT
        assert event.content == "Hello, world!"
    
    def test_tool_call_event(self):
        """测试工具调用事件"""
        event = RunOutputEvent(
            event_type=RunContentEvent.TOOL_CALL,
            tool_name="search",
            tool_args={"query": "test"}
        )
        
        assert event.event_type == RunContentEvent.TOOL_CALL
        assert event.tool_name == "search"
        assert event.tool_args == {"query": "test"}
    
    def test_tool_result_event(self):
        """测试工具结果事件"""
        event = RunOutputEvent(
            event_type=RunContentEvent.TOOL_RESULT,
            tool_name="search",
            tool_result={"results": ["item1", "item2"]}
        )
        
        assert event.event_type == RunContentEvent.TOOL_RESULT
        assert event.tool_result["results"] == ["item1", "item2"]
    
    def test_error_event(self):
        """测试错误事件"""
        event = RunOutputEvent(
            event_type=RunContentEvent.ERROR,
            error="An error occurred"
        )
        
        assert event.event_type == RunContentEvent.ERROR
        assert event.error == "An error occurred"


class TestCustomEvent:
    """CustomEvent 测试"""
    
    def test_custom_event_creation(self):
        """测试自定义事件"""
        event = CustomEvent(
            event_type="my_custom_event",
            data={"key": "value"}
        )
        
        assert event.event_type == "my_custom_event"
        assert event.data == {"key": "value"}


class TestRunRequirement:
    """RunRequirement 测试"""
    
    def test_requirement_creation(self):
        """测试需求创建"""
        req = RunRequirement(
            name="api_key",
            description="API key for authentication",
            required=True
        )
        
        assert req.name == "api_key"
        assert req.required == True
    
    def test_optional_requirement(self):
        """测试可选需求"""
        req = RunRequirement(
            name="debug_mode",
            required=False,
            default=False
        )
        
        assert req.required == False
        assert req.default == False


class TestTeamRunOutput:
    """TeamRunOutput 测试"""
    
    def test_team_output_creation(self):
        """测试团队输出创建"""
        outputs = [
            RunOutput(content="Agent 1 result"),
            RunOutput(content="Agent 2 result")
        ]
        
        team_output = TeamRunOutput(
            outputs=outputs,
            combined_content="Combined results"
        )
        
        assert len(team_output.outputs) == 2
        assert team_output.combined_content == "Combined results"


class TestToolResult:
    """ToolResult 测试"""
    
    def test_successful_result(self):
        """测试成功结果"""
        result = ToolResult(
            success=True,
            result="Operation completed"
        )
        
        assert result.success == True
        assert result.result == "Operation completed"
        assert result.error is None
    
    def test_failed_result(self):
        """测试失败结果"""
        result = ToolResult(
            success=False,
            error="Operation failed"
        )
        
        assert result.success == False
        assert result.error == "Operation failed"
    
    def test_result_with_complex_data(self):
        """测试复杂数据结果"""
        result = ToolResult(
            success=True,
            result={"items": [1, 2, 3], "total": 3}
        )
        
        assert result.result["total"] == 3
