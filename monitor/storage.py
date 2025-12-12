"""
存储后端

支持 SQLite、PostgreSQL、MySQL
"""

import json
import sqlite3
from abc import ABC, abstractmethod
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse


class StorageBackend(ABC):
    """存储后端抽象基类"""
    
    @abstractmethod
    def log(
        self,
        function_name: str,
        input_args: tuple = None,
        input_kwargs: dict = None,
        output: Any = None,
        error: str = None,
        exec_time: float = 0.0,
        **extra
    ) -> None:
        """记录一次调用"""
        pass
    
    @abstractmethod
    def get_logs(self, limit: int = 100) -> List[Dict]:
        """获取日志"""
        pass
    
    @abstractmethod
    def get_stats(self) -> Dict:
        """获取统计信息"""
        pass


class SQLiteStorage(StorageBackend):
    """SQLite 存储后端"""
    
    def __init__(self, db_path: str = None):
        """
        Args:
            db_path: 数据库路径，默认在当前目录
        """
        self.db_path = Path(db_path) if db_path else Path.cwd() / "agent_logs.db"
        self._init_db()
    
    def _init_db(self):
        """初始化数据库表"""
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                function_name TEXT NOT NULL,
                input_args TEXT,
                input_kwargs TEXT,
                output TEXT,
                error TEXT,
                exec_time REAL,
                extra TEXT
            )
        """)
        conn.commit()
        conn.close()
    
    def log(
        self,
        function_name: str,
        input_args: tuple = None,
        input_kwargs: dict = None,
        output: Any = None,
        error: str = None,
        exec_time: float = 0.0,
        **extra
    ) -> None:
        """记录日志"""
        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            INSERT INTO logs 
            (timestamp, function_name, input_args, input_kwargs, output, error, exec_time, extra)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            datetime.now().isoformat(),
            function_name,
            json.dumps(input_args, default=str) if input_args else None,
            json.dumps(input_kwargs, default=str) if input_kwargs else None,
            json.dumps(output, default=str) if output else None,
            error,
            exec_time,
            json.dumps(extra, default=str) if extra else None,
        ))
        conn.commit()
        conn.close()
    
    def get_logs(self, limit: int = 100) -> List[Dict]:
        """获取最近的日志"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            "SELECT * FROM logs ORDER BY id DESC LIMIT ?", (limit,)
        )
        rows = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return rows
    
    def get_stats(self) -> Dict:
        """获取统计信息"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.execute("""
            SELECT 
                COUNT(*) as total_calls,
                SUM(exec_time) as total_time,
                AVG(exec_time) as avg_time,
                COUNT(CASE WHEN error IS NOT NULL THEN 1 END) as error_count
            FROM logs
        """)
        row = cursor.fetchone()
        conn.close()
        return {
            "total_calls": row[0] or 0,
            "total_time": row[1] or 0.0,
            "avg_time": row[2] or 0.0,
            "error_count": row[3] or 0,
        }


class PostgreSQLStorage(StorageBackend):
    """PostgreSQL 存储后端"""
    
    def __init__(self, connection_url: str):
        """
        Args:
            connection_url: PostgreSQL 连接 URL
                例如: postgresql://user:pass@localhost:5432/dbname
        """
        self.connection_url = connection_url
        self._init_db()
    
    def _get_connection(self):
        """获取数据库连接"""
        try:
            import psycopg2
        except ImportError:
            raise ImportError("psycopg2 not installed. Run: pip install psycopg2-binary")
        
        return psycopg2.connect(self.connection_url)
    
    def _init_db(self):
        """初始化数据库表"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS logs (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                function_name TEXT NOT NULL,
                input_args JSONB,
                input_kwargs JSONB,
                output JSONB,
                error TEXT,
                exec_time REAL,
                extra JSONB
            )
        """)
        conn.commit()
        conn.close()
    
    def log(
        self,
        function_name: str,
        input_args: tuple = None,
        input_kwargs: dict = None,
        output: Any = None,
        error: str = None,
        exec_time: float = 0.0,
        **extra
    ) -> None:
        """记录日志"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO logs 
            (function_name, input_args, input_kwargs, output, error, exec_time, extra)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            function_name,
            json.dumps(input_args, default=str) if input_args else None,
            json.dumps(input_kwargs, default=str) if input_kwargs else None,
            json.dumps(output, default=str) if output else None,
            error,
            exec_time,
            json.dumps(extra, default=str) if extra else None,
        ))
        conn.commit()
        conn.close()
    
    def get_logs(self, limit: int = 100) -> List[Dict]:
        """获取最近的日志"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM logs ORDER BY id DESC LIMIT %s", (limit,)
        )
        columns = [desc[0] for desc in cursor.description]
        rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
        conn.close()
        return rows
    
    def get_stats(self) -> Dict:
        """获取统计信息"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                COUNT(*) as total_calls,
                SUM(exec_time) as total_time,
                AVG(exec_time) as avg_time,
                COUNT(CASE WHEN error IS NOT NULL THEN 1 END) as error_count
            FROM logs
        """)
        row = cursor.fetchone()
        conn.close()
        return {
            "total_calls": row[0] or 0,
            "total_time": float(row[1] or 0),
            "avg_time": float(row[2] or 0),
            "error_count": row[3] or 0,
        }


class MySQLStorage(StorageBackend):
    """MySQL 存储后端"""
    
    def __init__(self, connection_url: str):
        """
        Args:
            connection_url: MySQL 连接 URL
                例如: mysql://user:pass@localhost:3306/dbname
        """
        self.connection_url = connection_url
        self._init_db()
    
    def _get_connection(self):
        """获取数据库连接"""
        try:
            import pymysql
        except ImportError:
            raise ImportError("pymysql not installed. Run: pip install pymysql")
        
        parsed = urlparse(self.connection_url)
        return pymysql.connect(
            host=parsed.hostname or "localhost",
            port=parsed.port or 3306,
            user=parsed.username or "root",
            password=parsed.password or "",
            database=parsed.path.lstrip("/") if parsed.path else "agent_logs",
        )
    
    def _init_db(self):
        """初始化数据库表"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                function_name VARCHAR(255) NOT NULL,
                input_args JSON,
                input_kwargs JSON,
                output JSON,
                error TEXT,
                exec_time FLOAT,
                extra JSON
            )
        """)
        conn.commit()
        conn.close()
    
    def log(
        self,
        function_name: str,
        input_args: tuple = None,
        input_kwargs: dict = None,
        output: Any = None,
        error: str = None,
        exec_time: float = 0.0,
        **extra
    ) -> None:
        """记录日志"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO logs 
            (function_name, input_args, input_kwargs, output, error, exec_time, extra)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            function_name,
            json.dumps(input_args, default=str) if input_args else None,
            json.dumps(input_kwargs, default=str) if input_kwargs else None,
            json.dumps(output, default=str) if output else None,
            error,
            exec_time,
            json.dumps(extra, default=str) if extra else None,
        ))
        conn.commit()
        conn.close()
    
    def get_logs(self, limit: int = 100) -> List[Dict]:
        """获取最近的日志"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM logs ORDER BY id DESC LIMIT %s", (limit,)
        )
        columns = [desc[0] for desc in cursor.description]
        rows = [dict(zip(columns, row)) for row in cursor.fetchall()]
        conn.close()
        return rows
    
    def get_stats(self) -> Dict:
        """获取统计信息"""
        conn = self._get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT 
                COUNT(*) as total_calls,
                SUM(exec_time) as total_time,
                AVG(exec_time) as avg_time,
                SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as error_count
            FROM logs
        """)
        row = cursor.fetchone()
        conn.close()
        return {
            "total_calls": row[0] or 0,
            "total_time": float(row[1] or 0),
            "avg_time": float(row[2] or 0),
            "error_count": row[3] or 0,
        }


class Monitor:
    """
    统一监控管理器
    
    根据 URL 自动选择后端
    
    Usage:
        # SQLite (默认)
        monitor = Monitor()
        
        # SQLite 指定路径
        monitor = Monitor("./logs.db")
        
        # PostgreSQL
        monitor = Monitor("postgresql://user:pass@localhost/db")
        
        # MySQL
        monitor = Monitor("mysql://user:pass@localhost/db")
    """
    
    def __init__(self, connection: str = None):
        """
        Args:
            connection: 连接字符串或文件路径
        """
        self.storage = self._create_storage(connection)
    
    def _create_storage(self, connection: str = None) -> StorageBackend:
        """根据连接字符串创建存储后端"""
        if connection is None:
            return SQLiteStorage()
        
        if connection.startswith("postgresql://") or connection.startswith("postgres://"):
            return PostgreSQLStorage(connection)
        
        if connection.startswith("mysql://"):
            return MySQLStorage(connection)
        
        # 默认当作 SQLite 文件路径
        return SQLiteStorage(connection)
    
    def log(self, **kwargs) -> None:
        """记录日志"""
        self.storage.log(**kwargs)
    
    def get_logs(self, limit: int = 100) -> List[Dict]:
        """获取日志"""
        return self.storage.get_logs(limit)
    
    def get_stats(self) -> Dict:
        """获取统计"""
        return self.storage.get_stats()

    def log_conversation(
        self,
        model: str,
        input_prompt: str,
        output_content: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        exec_time: float = 0.0,
    ) -> None:
        """记录对话日志"""
        self.storage.log(
            function_name="agent_run",
            input_args=(input_prompt,),
            output=output_content,
            exec_time=exec_time,
            model=model,
            token_usage={
                "input": input_tokens,
                "output": output_tokens,
                "total": input_tokens + output_tokens
            }
        )
