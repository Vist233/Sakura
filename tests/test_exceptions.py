"""
Tests for Exception classes

测试 Sakura 框架的异常类
"""

import pytest

from sakura.exceptions import (
    AgentRunException,
    RetryAgentRun,
    StopAgentRun,
    RunCancelledException,
    SakuraError,
    ModelAuthenticationError,
    ModelProviderError,
    ModelRateLimitError,
    EvalError,
    CheckTrigger,
    InputCheckError,
    OutputCheckError,
)


class TestAgentRunException:
    """AgentRunException 测试"""
    
    def test_agent_run_exception_basic(self):
        """测试基础异常创建"""
        exc = AgentRunException("Test error")
        
        assert str(exc) == "Test error"
        assert exc.type == "agent_run_error"
        assert exc.error_id == "agent_run_error"
        assert exc.stop_execution == False
    
    def test_agent_run_exception_with_messages(self):
        """测试带消息的异常"""
        exc = AgentRunException(
            "Error occurred",
            user_message="Something went wrong",
            agent_message="Internal error"
        )
        
        assert exc.user_message == "Something went wrong"
        assert exc.agent_message == "Internal error"
    
    def test_agent_run_exception_with_stop(self):
        """测试停止执行标志"""
        exc = AgentRunException("Stop!", stop_execution=True)
        
        assert exc.stop_execution == True


class TestRetryAgentRun:
    """RetryAgentRun 测试"""
    
    def test_retry_agent_run_creation(self):
        """测试重试异常创建"""
        exc = RetryAgentRun("Retry needed")
        
        assert str(exc) == "Retry needed"
        assert exc.error_id == "retry_agent_run_error"
        assert exc.stop_execution == False
    
    def test_retry_agent_run_inherits_base(self):
        """测试继承关系"""
        exc = RetryAgentRun("Retry")
        
        assert isinstance(exc, AgentRunException)


class TestStopAgentRun:
    """StopAgentRun 测试"""
    
    def test_stop_agent_run_creation(self):
        """测试停止异常创建"""
        exc = StopAgentRun("Stop execution")
        
        assert str(exc) == "Stop execution"
        assert exc.error_id == "stop_agent_run_error"
        assert exc.stop_execution == True
    
    def test_stop_agent_run_inherits_base(self):
        """测试继承关系"""
        exc = StopAgentRun("Stop")
        
        assert isinstance(exc, AgentRunException)


class TestRunCancelledException:
    """RunCancelledException 测试"""
    
    def test_run_cancelled_default_message(self):
        """测试默认消息"""
        exc = RunCancelledException()
        
        assert "cancelled" in str(exc).lower()
        assert exc.type == "run_cancelled_error"
        assert exc.error_id == "run_cancelled_error"
    
    def test_run_cancelled_custom_message(self):
        """测试自定义消息"""
        exc = RunCancelledException("User cancelled the operation")
        
        assert str(exc) == "User cancelled the operation"


class TestSakuraError:
    """SakuraError 测试"""
    
    def test_sakura_error_basic(self):
        """测试基础错误"""
        err = SakuraError("Internal error")
        
        assert err.message == "Internal error"
        assert err.status_code == 500
        assert err.type == "sakura_error"
    
    def test_sakura_error_custom_status(self):
        """测试自定义状态码"""
        err = SakuraError("Bad request", status_code=400)
        
        assert err.status_code == 400
    
    def test_sakura_error_str(self):
        """测试字符串表示"""
        err = SakuraError("Error message")
        
        assert str(err) == "Error message"


class TestModelAuthenticationError:
    """ModelAuthenticationError 测试"""
    
    def test_auth_error_basic(self):
        """测试认证错误"""
        err = ModelAuthenticationError("Invalid API key")
        
        assert err.message == "Invalid API key"
        assert err.status_code == 401
        assert err.type == "model_authentication_error"
    
    def test_auth_error_with_model_name(self):
        """测试带模型名称的认证错误"""
        err = ModelAuthenticationError(
            "Auth failed",
            model_name="gpt-4"
        )
        
        assert err.model_name == "gpt-4"


class TestModelProviderError:
    """ModelProviderError 测试"""
    
    def test_provider_error_basic(self):
        """测试提供商错误"""
        err = ModelProviderError("Service unavailable")
        
        assert err.message == "Service unavailable"
        assert err.status_code == 502
        assert err.type == "model_provider_error"
    
    def test_provider_error_with_details(self):
        """测试带详细信息的错误"""
        err = ModelProviderError(
            "Request failed",
            status_code=503,
            model_name="claude-3",
            model_id="claude-3-opus"
        )
        
        assert err.status_code == 503
        assert err.model_name == "claude-3"
        assert err.model_id == "claude-3-opus"


class TestModelRateLimitError:
    """ModelRateLimitError 测试"""
    
    def test_rate_limit_error_basic(self):
        """测试速率限制错误"""
        err = ModelRateLimitError("Too many requests")
        
        assert err.message == "Too many requests"
        assert err.status_code == 429
        assert err.error_id == "model_rate_limit_error"
    
    def test_rate_limit_inherits_provider_error(self):
        """测试继承关系"""
        err = ModelRateLimitError("Rate limited")
        
        assert isinstance(err, ModelProviderError)
        assert isinstance(err, SakuraError)


class TestCheckTrigger:
    """CheckTrigger 枚举测试"""
    
    def test_check_trigger_values(self):
        """测试检查触发器值"""
        assert CheckTrigger.OFF_TOPIC.value == "off_topic"
        assert CheckTrigger.INPUT_NOT_ALLOWED.value == "input_not_allowed"
        assert CheckTrigger.OUTPUT_NOT_ALLOWED.value == "output_not_allowed"
        assert CheckTrigger.VALIDATION_FAILED.value == "validation_failed"
        assert CheckTrigger.PROMPT_INJECTION.value == "prompt_injection"
        assert CheckTrigger.PII_DETECTED.value == "pii_detected"


class TestInputCheckError:
    """InputCheckError 测试"""
    
    def test_input_check_error_basic(self):
        """测试输入检查错误"""
        err = InputCheckError("Invalid input")
        
        assert err.message == "Invalid input"
        assert err.type == "input_check_error"
        assert err.check_trigger == CheckTrigger.INPUT_NOT_ALLOWED
    
    def test_input_check_error_custom_trigger(self):
        """测试自定义触发器"""
        err = InputCheckError(
            "Prompt injection detected",
            check_trigger=CheckTrigger.PROMPT_INJECTION
        )
        
        assert err.check_trigger == CheckTrigger.PROMPT_INJECTION
        assert err.error_id == "prompt_injection"


class TestOutputCheckError:
    """OutputCheckError 测试"""
    
    def test_output_check_error_basic(self):
        """测试输出检查错误"""
        err = OutputCheckError("Invalid output")
        
        assert err.message == "Invalid output"
        assert err.type == "output_check_error"
        assert err.check_trigger == CheckTrigger.OUTPUT_NOT_ALLOWED
    
    def test_output_check_error_with_data(self):
        """测试带附加数据的错误"""
        err = OutputCheckError(
            "PII detected in output",
            check_trigger=CheckTrigger.PII_DETECTED,
            additional_data={"detected_types": ["email", "phone"]}
        )
        
        assert err.additional_data["detected_types"] == ["email", "phone"]


class TestEvalError:
    """EvalError 测试"""
    
    def test_eval_error_creation(self):
        """测试评估错误"""
        err = EvalError("Evaluation failed")
        
        assert str(err) == "Evaluation failed"
        assert isinstance(err, Exception)
