"""系统管理路由"""

import asyncio
import base64
import io
import json
import os
import shutil
import tempfile
from dataclasses import (
    asdict,
)

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
)
from fastapi.openapi.docs import (
    get_redoc_html,
    get_swagger_ui_html,
)
from fastapi.openapi.utils import (
    get_openapi,
)
from fastapi.responses import (
    FileResponse,
)
from qrcode.main import QRCode
from starlette.background import (
    BackgroundTask,
)

from xiaomusic import (
    __version__,
)
from xiaomusic.api.dependencies import (
    config,
    log,
    verification,
    xiaomusic,
)
from xiaomusic.qrcode_login import MiJiaAPI
from xiaomusic.utils.system_utils import (
    deepcopy_data_no_sensitive_info,
    get_latest_version,
    restart_xiaomusic,
    update_version,
)

router = APIRouter(dependencies=[Depends(verification)])


def _new_qr_client():
    # Resolve when called: configuration can change after router import. Always
    # name the file explicitly so missing/empty directories never select $HOME.
    auth_path = os.path.abspath(os.path.join(config.conf_path or "conf", "auth.json"))
    return MiJiaAPI(auth_data_path=auth_path)


def _auth_event(event, **fields):
    record = getattr(xiaomusic.auth_manager, "record_auth_event", None)
    if callable(record):
        record(event, **fields)


async def _verified_speaker_login(force_login=False):
    auth = xiaomusic.auth_manager
    await auth.init_all_data(force_login=force_login)
    if auth.mina_service is None:
        return None
    try:
        devices = await auth.mina_service.device_list()
    except Exception as exc:
        log.warning("Speaker session validation failed: %s", type(exc).__name__)
        return None
    return {
        "success": True,
        "already_logged_in": True,
        "device_count": len(devices),
        "qrcode_url": "",
        "message": (
            f"音箱账号已登录，发现 {len(devices)} 台设备，无需扫码"
            if devices
            else "音箱账号已登录，但该账号未返回小爱设备，请确认设备绑定账号"
        ),
    }


@router.get("/")
async def read_index():
    """首页"""
    folder = os.path.dirname(
        os.path.dirname(os.path.dirname(__file__))
    )  # xiaomusic 目录
    return FileResponse(f"{folder}/static/index.html")


@router.get("/api/get_qrcode")
async def get_qrcode():
    """生成小米账号扫码登录用二维码，返回 base64 图片 URL。"""
    try:
        verified = await _verified_speaker_login()
        if verified is not None:
            return verified
        client = _new_qr_client()
        qrcode_data = await asyncio.to_thread(client.get_qrcode)
        if qrcode_data is False:
            # A Mijia session does not prove that the speaker service accepted
            # its passToken. Reload the same persisted credentials in the SDK.
            verified = await _verified_speaker_login(force_login=True)
            if verified is not None:
                return verified
            # Let the user reauthenticate instead of hiding the QR indefinitely.
            qrcode_data = await asyncio.to_thread(client.get_qrcode, force=True)
            if qrcode_data is False:
                return {"success": False, "message": "音箱登录验证失败，请重新登录"}

        # 优先使用小米返回的官方二维码图片 URL，与扫码内容一致且最可靠
        if qrcode_data.get("qr"):
            qrcode_url = qrcode_data["qr"]
        else:
            # 无 qr 时用 loginUrl 本地生成二维码图
            qr = QRCode(version=1, box_size=8, border=2)
            qr.add_data(qrcode_data["loginUrl"])
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white")
            buf = io.BytesIO()
            img.save(buf, "PNG")
            buf.seek(0)
            b64 = base64.b64encode(buf.read()).decode("ascii")
            qrcode_url = f"data:image/png;base64,{b64}"
        # 返回二维码的同时，在后台启动 get_logint_status，不阻塞本次响应
        asyncio.create_task(get_logint_status(qrcode_data["lp"], client))
        _auth_event("qr_issued")
        return {
            "success": True,
            "qrcode_url": qrcode_url,
            "status_url": qrcode_data.get("lp", ""),
            "expire_seconds": config.qrcode_timeout,
        }
    except Exception as e:
        _auth_event("qr_issue_failed", error_type=type(e).__name__)
        log.warning("get_qrcode failed: %s", type(e).__name__)
        return {"success": False, "message": "二维码获取失败，请检查认证诊断日志"}


async def get_logint_status(lp: str, client=None):
    """轮询获取扫码登录状态"""
    try:
        client = client if client is not None else _new_qr_client()
        await asyncio.to_thread(client.get_logint_status, lp)
        _auth_event("qr_scan_completed")
        await xiaomusic.auth_manager.init_all_data(force_login=True)
        _auth_event("qr_speaker_initialization_completed",
                    service_available=xiaomusic.auth_manager.mina_service is not None)
    except Exception as exc:
        _auth_event("qr_poll_failed", error_type=type(exc).__name__)
        log.warning("QR login completion failed: %s", type(exc).__name__)


@router.get("/getversion")
def getversion():
    """获取版本"""
    log.debug("getversion %s", __version__)
    return {"version": __version__}


@router.get("/getsetting")
async def getsetting(need_device_list: bool = False):
    """获取设置"""
    config_data = xiaomusic.getconfig()
    data = asdict(config_data)
    data["password"] = "******"
    data["httpauth_password"] = "******"
    if need_device_list:
        device_list = await xiaomusic.getalldevices()
        log.info(f"getsetting device_list: {device_list}")
        data["device_list"] = device_list
    return data


@router.post("/savesetting")
async def savesetting(request: Request):
    """保存设置"""
    try:
        data_json = await request.body()
        data = json.loads(data_json.decode("utf-8"))
        debug_data = deepcopy_data_no_sensitive_info(data)
        log.info(f"saveconfig: {debug_data}")
        config_obj = xiaomusic.getconfig()
        if data.get("password") == "******" or data.get("password", "") == "":
            data["password"] = config_obj.password
        if (
            data.get("httpauth_password") == "******"
            or data.get("httpauth_password", "") == ""
        ):
            data["httpauth_password"] = config_obj.httpauth_password
        await xiaomusic.saveconfig(data)

        # 重置 HTTP 服务器配置
        from xiaomusic.api.app import app
        from xiaomusic.api.dependencies import reset_http_server

        reset_http_server(app)

        return "save success"
    except json.JSONDecodeError as err:
        raise HTTPException(status_code=400, detail="Invalid JSON") from err


@router.post("/api/system/modifiysetting")
async def modifiysetting(request: Request):
    """修改部分设置"""
    try:
        data_json = await request.body()
        data = json.loads(data_json.decode("utf-8"))
        debug_data = deepcopy_data_no_sensitive_info(data)
        log.info(f"modifiysetting: {debug_data}")

        config_obj = xiaomusic.getconfig()

        # 处理密码字段，如果是 ****** 或空字符串则保持原值
        if "password" in data and (
            data["password"] == "******" or data["password"] == ""
        ):
            data["password"] = config_obj.password
        if "httpauth_password" in data and (
            data["httpauth_password"] == "******" or data["httpauth_password"] == ""
        ):
            data["httpauth_password"] = config_obj.httpauth_password

        # 检查是否有HTTP服务器相关配置被修改
        has_http_config_changed = any(
            config_obj.is_http_server_config(key) for key in data.keys()
        )

        # 更新配置
        config_obj.update_config(data)

        # 如果有HTTP配置变更，重置HTTP服务器
        if has_http_config_changed:
            from xiaomusic.api.app import app
            from xiaomusic.api.dependencies import reset_http_server

            reset_http_server(app)
            log.info("HTTP server configuration has been reset")

        # 保存配置到文件
        xiaomusic.save_cur_config()

        return {"success": True, "message": "Configuration updated successfully"}
    except json.JSONDecodeError as err:
        raise HTTPException(status_code=400, detail="Invalid JSON") from err
    except Exception as err:
        log.error(f"Error updating configuration: {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.get("/downloadlog")
def downloadlog():
    """下载日志"""
    file_path = config.log_file
    if os.path.exists(file_path):
        # 创建一个临时文件来保存日志的快照
        temp_file = tempfile.NamedTemporaryFile(delete=False)
        try:
            with open(file_path, "rb") as f:
                shutil.copyfileobj(f, temp_file)
            temp_file.close()

            # 使用BackgroundTask在响应发送完毕后删除临时文件
            def cleanup_temp_file(tmp_file_path):
                os.remove(tmp_file_path)

            background_task = BackgroundTask(cleanup_temp_file, temp_file.name)
            return FileResponse(
                temp_file.name,
                media_type="text/plain",
                filename="xiaomusic.txt",
                background=background_task,
            )
        except Exception as e:
            os.remove(temp_file.name)
            raise HTTPException(
                status_code=500, detail="Error capturing log file"
            ) from e
    else:
        return {"message": "File not found."}


@router.get("/api/debug/simulate_token_expire")
async def simulate_token_expire():
    """模拟 token 过期（调试用）

    访问 http://IP:PORT/api/debug/simulate_token_expire 即可触发，
    模拟小米服务器端 serviceToken 过期后 mi_request 内部的行为：
    1. 清空内存 token (self.token = None)
    2. 删除 .mi.token 文件
    """
    auth = xiaomusic.auth_manager

    if auth.mina_service is None:
        return {"ret": "FAIL", "msg": "mina_service 为空，请先正常启动并登录"}

    if auth.mina_service.account and auth.mina_service.account.token:
        old_keys = list(auth.mina_service.account.token.keys())
    else:
        old_keys = []

    auth.mina_service.account.token = None

    token_file = os.path.join(auth.config.conf_path, ".mi.token")
    token_deleted = False
    if os.path.exists(token_file):
        os.remove(token_file)
        token_deleted = True

    return {
        "ret": "OK",
        "msg": "已模拟 token 过期",
        "old_token_keys": old_keys,
        "token_now": "None",
        "mi_token_file_deleted": token_deleted,
        "hint": "现在去网页看设备列表，观察日志中的 [AUTH] 输出",
    }


@router.get("/latestversion")
async def latest_version():
    """获取最新版本"""
    version = await get_latest_version("xiaomusic")
    if version:
        return {"ret": "OK", "version": version}
    else:
        return {"ret": "Fetch version failed"}


@router.post("/updateversion")
async def updateversion(version: str = "", lite: bool = True):
    """更新版本"""
    import asyncio

    ret = await update_version(version, lite)
    if ret != "OK":
        return {"ret": ret}

    asyncio.create_task(restart_xiaomusic())
    return {"ret": "OK"}


@router.get("/docs", include_in_schema=False)
async def get_swagger_documentation():
    """Swagger 文档"""
    return get_swagger_ui_html(openapi_url="/openapi.json", title="docs")


@router.get("/redoc", include_in_schema=False)
async def get_redoc_documentation():
    """ReDoc 文档"""
    return get_redoc_html(openapi_url="/openapi.json", title="docs")


@router.get("/openapi.json", include_in_schema=False)
async def openapi():
    """OpenAPI 规范"""
    from xiaomusic.api.app import app

    return get_openapi(title=app.title, version=app.version, routes=app.routes)
