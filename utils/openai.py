"""
Sakura OpenAI Utilities - OpenAI 特定工具函数

提供消息格式化等工具函数
"""

from typing import Any, Dict, List, Optional, Union
import base64

from ..media import Audio, Image, File


def images_to_message(images: List[Image]) -> List[Dict[str, Any]]:
    """
    将图片列表转换为 OpenAI 消息格式
    
    Args:
        images: 图片对象列表
    
    Returns:
        OpenAI 格式的图片内容列表
    """
    image_contents = []
    
    for image in images:
        if image.url:
            image_contents.append({
                "type": "image_url",
                "image_url": {"url": image.url}
            })
        elif image.base64_data or image.data or image.filepath:
            b64_data = image.to_base64()
            if b64_data:
                image_contents.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{image.mime_type};base64,{b64_data}"
                    }
                })
    
    return image_contents


def audio_to_message(audio: List[Audio]) -> List[Dict[str, Any]]:
    """
    将音频列表转换为 OpenAI 消息格式
    
    Args:
        audio: 音频对象列表
    
    Returns:
        OpenAI 格式的音频内容列表
    """
    audio_contents = []
    
    for aud in audio:
        if aud.url:
            audio_contents.append({
                "type": "input_audio",
                "input_audio": {
                    "url": aud.url,
                    "format": _get_audio_format(aud.mime_type)
                }
            })
        elif aud.base64_data or aud.data or aud.filepath:
            b64_data = aud.to_base64()
            if b64_data:
                audio_contents.append({
                    "type": "input_audio",
                    "input_audio": {
                        "data": b64_data,
                        "format": _get_audio_format(aud.mime_type)
                    }
                })
    
    return audio_contents


def _get_audio_format(mime_type: str) -> str:
    """从 MIME 类型获取音频格式"""
    format_map = {
        "audio/mp3": "mp3",
        "audio/mpeg": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/flac": "flac",
        "audio/opus": "opus",
        "audio/pcm": "pcm16",
    }
    return format_map.get(mime_type, "mp3")


def _format_file_for_message(file: File) -> Optional[Dict[str, Any]]:
    """
    格式化文件为 OpenAI 消息内容格式
    
    Args:
        file: 文件对象
    
    Returns:
        OpenAI 格式的文件内容，如果无法格式化则返回 None
    """
    # 检查是否是图片文件
    if file.mime_type and file.mime_type.startswith("image/"):
        b64_data = file.to_base64()
        if b64_data:
            return {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{file.mime_type};base64,{b64_data}"
                }
            }
    
    # 检查是否是文本文件
    if file.mime_type and (
        file.mime_type.startswith("text/") or
        file.mime_type in ["application/json", "application/xml"]
    ):
        text_content = file.read_text()
        if text_content:
            return {
                "type": "text",
                "text": f"[文件: {file.name or 'unnamed'}]\n{text_content}"
            }
    
    # 其他文件类型，返回 base64 编码的描述
    b64_data = file.to_base64()
    if b64_data and file.url:
        return {
            "type": "file",
            "file": {
                "url": file.url,
                "filename": file.name
            }
        }
    
    return None
