# Class-Based Agent 开发规范

> 让 Agent 开发像写普通 Python 类一样自然

---

## 1. 设计目标

### 1.1 当前问题

```python
# 当前方式：函数式配置
agent = Agent(
    model="qwen-plus",
    tools=[search, calculator],
    system_prompt="你是助手",
    instructions=["规则1", "规则2"],
)
```

**问题**：
- 工具与 Agent 分离，不够内聚
- 无法利用 OOP 的继承、复用优势
- 配置散落各处

### 1.2 目标方式

```python
# 目标方式：类定义
class MyAgent(Agent):
    model = "qwen-plus"
    prompt = "你是助手"
    
    @tool
    def search(self, query: str) -> str:
        """搜索"""
        pass
```

---

## 2. 核心设计

### 2.1 BaseAgent 元类

```python
from typing import Any, Dict, List, Type

class AgentMeta(type):
    """Agent 元类 - 自动收集类方法作为工具"""
    
    def __new__(mcs, name: str, bases: tuple, namespace: Dict[str, Any]):
        cls = super().__new__(mcs, name, bases, namespace)
        
        # 跳过基类
        if name == "Agent":
            return cls
        
        # 收集被 @tool 装饰的方法
        tools = []
        for attr_name, attr_value in namespace.items():
            if hasattr(attr_value, "_is_tool"):
                tools.append(attr_value)
        
        # 存储到类属性
        cls._class_tools = tools
        
        return cls


class Agent(metaclass=AgentMeta):
    """
    Base Agent 类
    
    类配置属性：
        model: 模型名称或实例
        prompt: 系统提示词
        guidelines: 行为准则列表
        tools: 额外工具列表
    """
    
    # 类级别默认配置
    model: str = None
    prompt: str = None
    guidelines: List = []
    tools: List = []
    
    def __init__(self, **kwargs):
        # 实例配置覆盖类配置
        self.model = kwargs.get("model", self.__class__.model)
        self.prompt = kwargs.get("prompt", self.__class__.prompt)
        self.guidelines = kwargs.get("guidelines", self.__class__.guidelines.copy())
        
        # 合并类工具和实例工具
        class_tools = getattr(self.__class__, "_class_tools", [])
        instance_tools = kwargs.get("tools", [])
        self._all_tools = class_tools + instance_tools + self.__class__.tools
        
        # 初始化
        self._setup()
    
    def _setup(self):
        """初始化设置（子类可重写）"""
        pass
```

### 2.2 工具装饰器增强

```python
from functools import wraps

def tool(func=None, *, name=None, prompt=None):
    """
    工具装饰器 - 支持类方法
    
    Args:
        name: 覆盖工具名称
        prompt: 工具描述（原 description）
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            return fn(*args, **kwargs)
        
        # 标记为工具方法
        wrapper._is_tool = True
        wrapper._tool_name = name or fn.__name__
        wrapper._tool_prompt = prompt
        
        return wrapper
    
    if func is not None:
        return decorator(func)
    return decorator
```

---

## 3. 完整示例

### 3.1 基础 Agent 定义

```python
from sakura import Agent, Guideline
from sakura.tools import tool

class CustomerServiceAgent(Agent):
    """客服 Agent"""
    
    # 配置
    model = "qwen-plus"
    prompt = """你是一个专业的客服助手。
    
    你的职责：
    - 帮助客户解决问题
    - 处理订单相关事务
    - 提供产品信息
    """
    
    guidelines = [
        Guideline(
            condition="客户情绪激动时",
            action="首先表示理解和歉意"
        ),
        Guideline(
            condition="涉及退款时",
            action="验证订单后检查退款条件"
        ),
    ]
    
    # 工具方法
    @tool
    def check_order(self, order_id: str) -> str:
        """查询订单状态"""
        # 实际业务逻辑
        return f"订单 {order_id} 状态：已发货"
    
    @tool
    def process_refund(self, order_id: str, reason: str) -> str:
        """处理退款申请"""
        return f"退款申请已提交，订单号：{order_id}"
    
    @tool(name="get_product_info", prompt="获取产品详细信息")
    def product_info(self, product_id: str) -> str:
        """获取产品信息"""
        return f"产品 {product_id} 详情..."


# 使用
agent = CustomerServiceAgent()
response = agent.run("我要查询订单 12345 的状态")
```

### 3.2 Agent 继承

```python
class VIPCustomerServiceAgent(CustomerServiceAgent):
    """VIP 客服 Agent - 继承基础客服并增强"""
    
    prompt = CustomerServiceAgent.prompt + """
    
    VIP 客户特殊待遇：
    - 优先处理
    - 额外折扣权限
    - 专属礼品
    """
    
    guidelines = CustomerServiceAgent.guidelines + [
        Guideline(
            condition="VIP 客户请求时",
            action="优先处理并提供专属优惠"
        ),
    ]
    
    @tool
    def apply_vip_discount(self, order_id: str, discount: float) -> str:
        """应用 VIP 折扣"""
        return f"订单 {order_id} 已应用 {discount*100}% 折扣"
```

### 3.3 Mixin 模式

```python
class DatabaseMixin:
    """数据库操作 Mixin"""
    
    @tool
    def query_database(self, sql: str) -> str:
        """执行数据库查询"""
        pass

class FileMixin:
    """文件操作 Mixin"""
    
    @tool
    def read_file(self, path: str) -> str:
        """读取文件"""
        pass

class FullFeaturedAgent(Agent, DatabaseMixin, FileMixin):
    """全功能 Agent"""
    model = "qwen-plus"
    prompt = "你是一个全能助手"
```

---

## 4. 生命周期钩子

```python
class Agent:
    # ... 其他代码 ...
    
    def on_init(self):
        """初始化完成后调用"""
        pass
    
    def on_before_run(self, prompt: str, messages: List[Message] = None):
        """运行前调用
        
        Args:
            prompt: 用户输入
            messages: 历史消息
        
        Returns:
            修改后的 (prompt, messages) 或 None
        """
        pass
    
    def on_after_run(self, response: ModelResponse) -> Optional[ModelResponse]:
        """运行后调用
        
        Args:
            response: 模型响应
        
        Returns:
            修改后的响应或 None
        """
        pass
    
    def on_tool_call(self, tool_name: str, args: Dict) -> Optional[Dict]:
        """工具调用前
        
        Returns:
            修改后的参数或 None
        """
        pass
    
    def on_tool_result(self, tool_name: str, result: Any) -> Optional[Any]:
        """工具调用后
        
        Returns:
            修改后的结果或 None
        """
        pass
    
    def on_error(self, error: Exception) -> Optional[str]:
        """错误处理
        
        Returns:
            错误消息或 None（重新抛出）
        """
        pass
```

### 使用示例

```python
class LoggingAgent(Agent):
    """带日志的 Agent"""
    
    def on_before_run(self, prompt, messages):
        print(f"📥 Input: {prompt}")
        return None  # 不修改
    
    def on_after_run(self, response):
        print(f"📤 Output: {response.content[:100]}...")
        return None
    
    def on_tool_call(self, tool_name, args):
        print(f"🔧 Tool: {tool_name}({args})")
        return None
    
    def on_error(self, error):
        print(f"❌ Error: {error}")
        return None  # 重新抛出
```

---

## 5. 配置优先级

```
实例参数 > 类属性 > 父类属性 > 默认值
```

```python
class BaseAgent(Agent):
    model = "qwen-turbo"
    prompt = "基础提示"

class MyAgent(BaseAgent):
    model = "qwen-plus"  # 覆盖父类

# 使用
agent1 = MyAgent()  # model = "qwen-plus"
agent2 = MyAgent(model="qwen-max")  # model = "qwen-max"
```

---

## 6. 类型提示支持

```python
from typing import List, Optional
from sakura import Agent, Guideline, ModelResponse
from sakura.tools import tool

class TypedAgent(Agent):
    model: str = "qwen-plus"
    prompt: str = "你是助手"
    guidelines: List[Guideline] = []
    
    @tool
    def search(self, query: str, limit: int = 10) -> List[str]:
        """搜索"""
        return ["result1", "result2"]
    
    def run(self, prompt: str) -> ModelResponse:
        """类型提示的 run 方法"""
        return super().run(prompt)
```

---

## 7. 测试支持

```python
import pytest
from sakura import Agent
from sakura.tools import tool
from unittest.mock import MagicMock

class TestableAgent(Agent):
    model = "mock"
    
    @tool
    def fetch_data(self, id: str) -> str:
        """获取数据"""
        return "real_data"

class TestAgent:
    def test_tool_registration(self):
        """测试工具是否正确注册"""
        agent = TestableAgent()
        assert "fetch_data" in agent.tool_names
    
    def test_tool_execution(self):
        """测试工具执行"""
        agent = TestableAgent()
        result = agent._execute_tool("fetch_data", {"id": "123"})
        assert result == "real_data"
    
    def test_with_mock(self):
        """使用 Mock 测试"""
        agent = TestableAgent()
        agent._model = MagicMock()
        agent._model.response.return_value = ModelResponse(content="mocked")
        
        response = agent.run("test")
        assert response.content == "mocked"
```

---

## 8. 迁移指南

### 从函数式到类式

**Before:**
```python
agent = Agent(
    model="qwen-plus",
    tools=[search_tool, calc_tool],
    system_prompt="你是助手",
    instructions=["规则1"],
)
```

**After:**
```python
class MyAgent(Agent):
    model = "qwen-plus"
    prompt = "你是助手"
    guidelines = [Guideline(condition="始终", action="规则1")]
    
    @tool
    def search(self, query: str): ...
    
    @tool
    def calc(self, expr: str): ...

agent = MyAgent()
```
