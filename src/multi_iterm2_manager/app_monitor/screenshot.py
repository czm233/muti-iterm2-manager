"""窗口截图模块 - 使用 Quartz (CoreGraphics) API 截取指定窗口"""
from __future__ import annotations

import base64
import logging

logger = logging.getLogger(__name__)

try:
    import Quartz  # type: ignore
except Exception:
    Quartz = None

try:
    import AppKit  # type: ignore
except Exception:
    AppKit = None


def check_screen_recording_permission() -> bool:
    """检查是否有屏幕录制权限"""
    if Quartz is None:
        return False
    try:
        return bool(Quartz.CGPreflightScreenCaptureAccess())
    except Exception:
        return False


def capture_window(
    window_id: int,
    max_width: int = 600,
    quality: float = 0.4,
) -> tuple[str, int, int] | None:
    """截取指定窗口并返回 base64 编码的 JPEG 数据

    Returns:
        (base64_jpeg, width, height) 或 None
    """
    if Quartz is None or AppKit is None:
        logger.warning("Quartz/AppKit 不可用，无法截图")
        return None

    try:
        # CGRectNull 会让 CoreGraphics 返回“目标窗口自身的包围盒”，
        # 避免 CGRectInfinite 把整块屏幕也截进来，导致窗口只缩在左上角。
        cg_rect = Quartz.CGRectNull
    except Exception:
        cg_rect = Quartz.CGRectMake(0, 0, 0, 0)

    try:
        image_options = Quartz.kCGWindowImageNominalResolution
        image_options |= getattr(Quartz, "kCGWindowImageBoundsIgnoreFraming", 0)
        cg_image = Quartz.CGWindowListCreateImage(
            cg_rect,
            Quartz.kCGWindowListOptionIncludingWindow,
            window_id,
            image_options,
        )
        if cg_image is None:
            logger.debug("CGWindowListCreateImage 返回空，窗口 %d 可能已不存在", window_id)
            return None

        width = int(Quartz.CGImageGetWidth(cg_image))
        height = int(Quartz.CGImageGetHeight(cg_image))
        if width == 0 or height == 0:
            return None

        # 使用 CGContext 缩放到目标宽度
        if width > max_width and max_width > 0:
            scale = float(max_width) / float(width)
            new_w = int(width * scale)
            new_h = int(height * scale)
            color_space = Quartz.CGColorSpaceCreateDeviceRGB()
            ctx = Quartz.CGBitmapContextCreate(
                None, new_w, new_h, 8, 0, color_space,
                Quartz.kCGImageAlphaPremultipliedLast,
            )
            Quartz.CGContextSetInterpolationQuality(ctx, Quartz.kCGInterpolationHigh)
            Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, 0, new_w, new_h), cg_image)
            cg_image = Quartz.CGBitmapContextCreateImage(ctx)
            width, height = new_w, new_h

        # CGImage → NSBitmapImageRep → JPEG
        bitmap = AppKit.NSBitmapImageRep.alloc().initWithCGImage_(cg_image)
        jpeg_data = bitmap.representationUsingType_properties_(
            AppKit.NSBitmapImageFileTypeJPEG,
            {AppKit.NSImageCompressionFactor: float(quality)},
        )

        b64 = base64.b64encode(jpeg_data.bytes()).decode()
        return (b64, width, height)

    except Exception:
        logger.exception("截取窗口 %d 时发生错误", window_id)
        return None
