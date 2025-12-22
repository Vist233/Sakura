"""
SubAgent 集成测试

使用真实的 DashScope qwen-plus API 测试 SubAgent 功能

运行: pytest tests/test_subagent_integration.py -v -s

注意: 需要设置 DASHSCOPE_API_KEY 环境变量
"""

import asyncio
import os
import pytest
from typing import List, Dict

# 检查是否有 API Key
HAS_API_KEY = bool(os.getenv("DASHSCOPE_API_KEY"))

# 跳过没有 API Key 的情况
pytestmark = pytest.mark.skipif(
    not HAS_API_KEY, 
    reason="DASHSCOPE_API_KEY not set"
)


# 辅助函数：直接调用 subagent（绕过 Function 包装）
def call_subagent(prompt: str, config: str = "general_purpose", context: str = "") -> str:
    """直接调用 subagent 的 entrypoint"""
    from sakura.tools.subagent.tool import subagent
    return subagent.entrypoint(prompt=prompt, config=config, context=context)


async def call_parallel_subagents(tasks: List[Dict]) -> str:
    """直接调用 parallel_subagents 的 entrypoint"""
    from sakura.tools.subagent.tool import parallel_subagents
    return await parallel_subagents.entrypoint(tasks=tasks)


class TestSubAgentBasic:
    """SubAgent 基础功能测试"""
    
    def test_subagent_simple_call(self):
        """测试: 子 Agent 能像父 Agent 一样完成任务"""
        # 调用子 Agent 执行简单任务
        result = call_subagent(
            prompt="请用一句话解释什么是 Python",
            config="general_purpose"
        )
        
        # 验证返回结果
        assert result is not None
        assert len(result) > 0
        assert "[general_purpose]" in result
        print(f"\n✅ 结果: {result[:200]}...")
    
    def test_subagent_with_context(self):
        """测试: 子 Agent 接收上下文信息"""
        context = """
        项目背景：我们正在开发一个 AI Agent 框架
        技术栈：Python, OpenAI API
        """
        
        result = call_subagent(
            prompt="基于背景信息，给出一个简短的项目总结",
            config="general_purpose",
            context=context
        )
        
        assert result is not None
        assert len(result) > 0
        print(f"\n✅ 有上下文结果: {result[:200]}...")
    
    def test_subagent_researcher_config(self):
        """测试: 使用 researcher 配置"""
        result = call_subagent(
            prompt="简要说明 Python GIL 是什么",
            config="researcher"
        )
        
        assert result is not None
        assert "[researcher]" in result
        print(f"\n✅ Researcher 结果: {result[:200]}...")


class TestSubAgentParallel:
    """SubAgent 并行执行测试"""
    
    @pytest.mark.asyncio
    async def test_parallel_subagents_basic(self):
        """测试: 并行执行多个子 Agent"""
        tasks = [
            {"prompt": "用一句话解释什么是变量", "config": "general_purpose"},
            {"prompt": "用一句话解释什么是函数", "config": "general_purpose"},
        ]
        
        result = await call_parallel_subagents(tasks)
        
        assert result is not None
        assert "并行 SubAgent 执行结果" in result
        print(f"\n✅ 并行结果:\n{result[:500]}...")
    
    @pytest.mark.asyncio
    async def test_parallel_subagents_different_configs(self):
        """测试: 并行执行不同配置的子 Agent"""
        tasks = [
            {"prompt": "概述 Python 的优点", "config": "researcher"},
            {"prompt": "写一个简单的 hello world", "config": "coder"},
        ]
        
        result = await call_parallel_subagents(tasks)
        
        assert result is not None
        # 应该有两个子 Agent 的结果
        assert "[researcher]" in result or "researcher" in result.lower()
        assert "[coder]" in result or "coder" in result.lower()
        print(f"\n✅ 不同配置并行结果:\n{result[:600]}...")


class TestSubAgentAsMainAgentTool:
    """测试 SubAgent 作为主 Agent 的工具"""
    
    def test_main_agent_calls_subagent(self):
        """测试: 主 Agent 调用 SubAgent 工具"""
        from sakura import Agent
        from sakura.tools.subagent import subagent
        
        # 创建主 Agent，只有 subagent 工具
        agent = Agent(
            model="qwen-plus",
            tools=[subagent],
            system_prompt="你是一个项目经理，可以调用 subagent 工具分派任务给专家。",
        )
        
        # 运行主 Agent
        response = agent.run("请帮我用一句话解释什么是递归")
        
        assert response is not None
        assert response.content is not None
        print(f"\n✅ 主 Agent 调用 SubAgent 结果:\n{response.content[:300]}...")


class TestCreateSubagent:
    """测试 create_subagent 高级用法"""
    
    def test_create_subagent_basic(self):
        """测试: 使用 create_subagent 创建 Agent 实例"""
        from sakura.tools.subagent import create_subagent
        
        # 创建子 Agent 实例
        agent = create_subagent("general_purpose")
        
        # 验证是 Agent 实例
        from sakura import Agent
        assert isinstance(agent, Agent)
        
        # 执行
        result = agent.run("说 'Hello'")
        
        assert result is not None
        assert result.content is not None
        print(f"\n✅ create_subagent 结果: {result.content[:100]}...")
    
    def test_create_subagent_with_override(self):
        """测试: 使用 create_subagent 覆盖配置"""
        from sakura.tools.subagent import create_subagent
        
        # 创建子 Agent 并覆盖模型
        agent = create_subagent(
            "general_purpose",
            model="qwen-plus",  # 覆盖默认模型
        )
        
        result = agent.run("输出数字 42")
        
        assert result is not None
        assert "42" in result.content
        print(f"\n✅ 覆盖配置结果: {result.content[:100]}...")


class TestSubAgentConfigLoading:
    """测试配置加载（不需要 API）"""
    
    def test_load_builtin_configs(self):
        """测试: 加载内置配置"""
        from sakura.tools.subagent import SubAgentConfig, SubAgentConfigLoader
        
        loader = SubAgentConfigLoader()
        available = loader.list_available()
        
        # 应该有内置配置
        assert len(available) > 0
        assert "researcher" in available
        assert "coder" in available
        assert "general_purpose" in available
        print(f"\n✅ 可用配置: {available}")
    
    def test_config_has_correct_fields(self):
        """测试: 配置包含正确字段"""
        from sakura.tools.subagent import SubAgentConfig, get_config_loader
        
        loader = get_config_loader()
        config = loader.load("researcher")
        
        assert config is not None
        assert config.name == "researcher"
        assert config.model == "qwen-plus"
        assert len(config.tools) > 0
        assert len(config.system_prompt) > 0
        print(f"\n✅ Researcher 配置:")
        print(f"   - name: {config.name}")
        print(f"   - model: {config.model}")
        print(f"   - tools: {config.tools}")
        print(f"   - system_prompt: {config.system_prompt[:100]}...")
    
    def test_load_nonexistent_config(self):
        """测试: 加载不存在的配置返回 None"""
        from sakura.tools.subagent import get_config_loader
        
        loader = get_config_loader()
        config = loader.load("nonexistent_config_xyz")
        
        assert config is None
        print(f"\n✅ 不存在的配置返回 None")
    
    def test_config_caching(self):
        """测试: 配置加载缓存机制"""
        from sakura.tools.subagent import SubAgentConfigLoader
        
        loader = SubAgentConfigLoader()
        
        # 首次加载
        config1 = loader.load("researcher")
        # 再次加载（应该使用缓存）
        config2 = loader.load("researcher")
        
        # 应该是同一个对象
        assert config1 is config2
        print(f"\n✅ 缓存机制正常工作")
    
    def test_load_all_configs(self):
        """测试: 加载所有配置"""
        from sakura.tools.subagent import SubAgentConfigLoader
        
        loader = SubAgentConfigLoader()
        all_configs = loader.load_all()
        
        assert len(all_configs) >= 4
        assert "researcher" in all_configs
        assert "coder" in all_configs
        print(f"\n✅ 加载所有配置: {list(all_configs.keys())}")
    
    def test_config_reload(self):
        """测试: 强制重新加载配置"""
        from sakura.tools.subagent import SubAgentConfigLoader
        
        loader = SubAgentConfigLoader()
        
        config1 = loader.load("researcher")
        config2 = loader.reload("researcher")
        
        # reload 应该创建新对象
        assert config1 is not config2
        # 但内容应该相同
        assert config1.name == config2.name
        print(f"\n✅ 重新加载配置正常")
    
    def test_config_to_dict(self):
        """测试: 配置转换为字典"""
        from sakura.tools.subagent import get_config_loader
        
        loader = get_config_loader()
        config = loader.load("coder")
        
        config_dict = config.to_dict()
        
        assert "name" in config_dict
        assert "model" in config_dict
        assert "tools" in config_dict
        assert "system_prompt" in config_dict
        assert config_dict["name"] == "coder"
        print(f"\n✅ 配置转字典: {list(config_dict.keys())}")


class TestSubAgentErrorHandling:
    """测试错误处理"""
    
    def test_subagent_invalid_config(self):
        """测试: 使用无效配置名调用 subagent"""
        result = call_subagent(
            prompt="test",
            config="invalid_config_name"
        )
        
        # 应该返回错误信息
        assert "错误" in result or "未找到" in result
        print(f"\n✅ 无效配置错误处理: {result[:100]}...")
    
    def test_subagent_empty_prompt(self):
        """测试: 空 prompt 调用 subagent"""
        result = call_subagent(
            prompt="",
            config="general_purpose"
        )
        
        # 应该能处理空 prompt（不崩溃）
        assert result is not None
        print(f"\n✅ 空 prompt 处理正常")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
