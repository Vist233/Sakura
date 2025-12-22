# Parlant Guidelines 模式实现指南

> 将 instructions 演化为 condition + action 的 Guidelines 系统

---

## 1. Parlant 核心理念

### 1.1 从 Prompt Engineering 到 Principle-Driven Development

传统方式：
```python
system_prompt = """
你是一个客服助手。
1. 始终使用礼貌用语
2. 退款需要订单号
3. 处理投诉时先表示歉意
...（更多规则）
"""
```

**问题**：规则越多，上下文窗口越大，LLM 越难遵守。

Parlant 方式：
```python
guidelines = [
    Guideline(condition="对话开始时", action="问候客户并询问需求"),
    Guideline(condition="客户询问退款", action="请求订单号"),
    Guideline(condition="客户表达不满", action="首先表示歉意"),
]
# 根据上下文动态选择 1-3 条相关规则注入
```

---

## 2. 数据模型设计

### 2.1 Guideline 类

```python
from dataclasses import dataclass, field
from typing import Optional, Literal, List
from enum import Enum

class GuidelinePriority(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"

@dataclass
class Guideline:
    """
    行为准则 - Parlant 风格
    
    Args:
        condition: 触发条件，描述何时应用此规则
        action: 执行动作，描述 Agent 应该做什么
        priority: 优先级，高优先级规则优先注入
        enabled: 是否启用
        tags: 标签，用于分组和筛选
    
    Examples:
        Guideline(
            condition="客户情绪激动时",
            action="首先表示理解和歉意，然后再解决问题",
            priority="high"
        )
    """
    condition: str
    action: str
    priority: GuidelinePriority = GuidelinePriority.MEDIUM
    enabled: bool = True
    tags: List[str] = field(default_factory=list)
    
    def matches(self, context: str) -> bool:
        """简单的条件匹配（可扩展为 LLM 评估）"""
        # 基础实现：关键词匹配
        keywords = self.condition.lower().split()
        return any(kw in context.lower() for kw in keywords)
    
    def to_prompt(self) -> str:
        """转换为 Prompt 片段"""
        return f"当 {self.condition}，请 {self.action}"
```

### 2.2 GuidelineManager 类

```python
from typing import List, Optional

class GuidelineManager:
    """
    Guidelines 管理器 - 支持动态选择
    """
    
    def __init__(self, guidelines: List[Guideline] = None):
        self._guidelines = guidelines or []
    
    def add(self, guideline: Guideline):
        """添加规则"""
        self._guidelines.append(guideline)
    
    def get_all(self, include_disabled: bool = False) -> List[Guideline]:
        """获取所有规则"""
        if include_disabled:
            return self._guidelines
        return [g for g in self._guidelines if g.enabled]
    
    def get_by_tag(self, tag: str) -> List[Guideline]:
        """按标签筛选"""
        return [g for g in self._guidelines if tag in g.tags and g.enabled]
    
    def get_relevant(
        self, 
        context: str, 
        max_count: int = 5,
        mode: Literal["keyword", "llm"] = "keyword"
    ) -> List[Guideline]:
        """
        动态选择相关规则
        
        Args:
            context: 当前对话上下文
            max_count: 最多返回的规则数
            mode: 匹配模式 - keyword(关键词) 或 llm(LLM评估)
        """
        if mode == "keyword":
            matched = [g for g in self._guidelines if g.enabled and g.matches(context)]
        else:
            # TODO: LLM 评估实现
            matched = self._guidelines
        
        # 按优先级排序
        priority_order = {
            GuidelinePriority.CRITICAL: 0,
            GuidelinePriority.HIGH: 1,
            GuidelinePriority.MEDIUM: 2,
            GuidelinePriority.LOW: 3,
        }
        matched.sort(key=lambda g: priority_order.get(g.priority, 2))
        
        return matched[:max_count]
    
    def to_prompt(self, guidelines: List[Guideline] = None) -> str:
        """将规则列表转换为 Prompt 文本"""
        rules = guidelines or self.get_all()
        if not rules:
            return ""
        
        lines = ["## 行为准则", ""]
        for i, g in enumerate(rules, 1):
            lines.append(f"{i}. {g.to_prompt()}")
        
        return "\n".join(lines)
```

---

## 3. 集成到 Agent

### 3.1 Agent 类修改

```python
@dataclass
class Agent:
    """
    统一的 Agent 类 - Parlant 风格
    """
    
    # 模型配置
    model: Union[str, Model] = None
    
    # 工具配置
    tools: List[Union[Function, Callable]] = field(default_factory=list)
    
    # 提示词配置
    prompt: Optional[str] = None  # 原 system_prompt
    
    # Guidelines 配置（替代 instructions）
    guidelines: List[Guideline] = field(default_factory=list)
    guideline_mode: Literal["all", "dynamic"] = "all"
    max_guidelines: int = 5
    
    # 内部状态
    _guideline_manager: Optional[GuidelineManager] = field(default=None, init=False)
    
    def __post_init__(self):
        # 初始化 GuidelineManager
        self._guideline_manager = GuidelineManager(self.guidelines)
    
    def _build_system_message(self, context: str = "") -> str:
        """构建系统消息（动态注入相关规则）"""
        parts = []
        
        if self.prompt:
            parts.append(self.prompt)
        
        # 根据模式选择规则
        if self.guideline_mode == "dynamic" and context:
            relevant = self._guideline_manager.get_relevant(
                context, 
                max_count=self.max_guidelines
            )
            guidelines_prompt = self._guideline_manager.to_prompt(relevant)
        else:
            guidelines_prompt = self._guideline_manager.to_prompt()
        
        if guidelines_prompt:
            parts.append(guidelines_prompt)
        
        return "\n\n".join(parts)
```

### 3.2 使用示例

```python
from sakura import Agent, Guideline

# 创建客服 Agent
agent = Agent(
    model="qwen-plus",
    prompt="你是一个专业的客服助手",
    guidelines=[
        Guideline(
            condition="对话开始时",
            action="问候客户并询问需求",
            priority="high"
        ),
        Guideline(
            condition="客户询问退款",
            action="请求订单号，检查退款条件",
            tags=["refund"]
        ),
        Guideline(
            condition="客户表达不满或投诉",
            action="首先表示歉意，表达理解",
            priority="critical"
        ),
        Guideline(
            condition="问题解决后",
            action="询问是否还有其他问题，礼貌告别",
            priority="low"
        ),
    ],
    guideline_mode="dynamic",  # 动态选择相关规则
)

response = agent.run("我要退款！这个产品太差了！")
# Agent 会自动注入 "退款" 和 "不满" 相关的规则
```

---

## 4. 轮询模式实现

### 4.1 多轮对话中的规则更新

```python
class Agent:
    def run_with_history(
        self, 
        prompt: str,
        messages: List[Message] = None
    ) -> ModelResponse:
        """支持多轮对话的运行方法"""
        
        # 构建上下文（包含历史消息）
        context = self._build_context(prompt, messages)
        
        # 动态选择规则
        system_message = self._build_system_message(context)
        
        # 构建完整消息列表
        all_messages = [Message(role="system", content=system_message)]
        if messages:
            all_messages.extend(messages)
        all_messages.append(Message(role="user", content=prompt))
        
        # 调用模型
        return self._model.response(
            messages=all_messages,
            tools=self._functions.values(),
        )
    
    def _build_context(self, prompt: str, messages: List[Message] = None) -> str:
        """构建上下文用于规则匹配"""
        parts = [prompt]
        if messages:
            # 只取最近几轮对话
            recent = messages[-6:]
            parts.extend([m.content for m in recent if m.content])
        return " ".join(parts)
```

---

## 5. 向后兼容

### 5.1 Deprecation Warning

```python
import warnings

@dataclass
class Agent:
    # 新属性
    prompt: Optional[str] = None
    guidelines: List[Guideline] = field(default_factory=list)
    
    # 旧属性（保留但标记废弃）
    system_prompt: Optional[str] = field(default=None, repr=False)
    instructions: Optional[List[str]] = field(default=None, repr=False)
    
    def __post_init__(self):
        # 兼容旧属性
        if self.system_prompt is not None:
            warnings.warn(
                "system_prompt is deprecated, use prompt instead",
                DeprecationWarning
            )
            if self.prompt is None:
                self.prompt = self.system_prompt
        
        if self.instructions is not None:
            warnings.warn(
                "instructions is deprecated, use guidelines instead",
                DeprecationWarning
            )
            if not self.guidelines:
                # 将字符串列表转换为 Guidelines
                self.guidelines = [
                    Guideline(condition="始终", action=inst)
                    for inst in self.instructions
                ]
```

---

## 6. 测试策略

```python
class TestGuideline:
    def test_keyword_matching(self):
        g = Guideline(condition="退款请求", action="检查订单")
        assert g.matches("我要退款") is True
        assert g.matches("查询订单") is False
    
    def test_priority_sorting(self):
        manager = GuidelineManager([
            Guideline(condition="a", action="1", priority="low"),
            Guideline(condition="b", action="2", priority="critical"),
            Guideline(condition="c", action="3", priority="medium"),
        ])
        result = manager.get_relevant("test", max_count=3)
        assert result[0].priority == GuidelinePriority.CRITICAL

class TestAgentWithGuidelines:
    def test_dynamic_guideline_injection(self):
        agent = Agent(
            model="mock",
            guidelines=[
                Guideline(condition="退款", action="处理退款"),
                Guideline(condition="投诉", action="表示歉意"),
            ],
            guideline_mode="dynamic"
        )
        system = agent._build_system_message("我要退款")
        assert "处理退款" in system
```
