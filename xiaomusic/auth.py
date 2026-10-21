"""认证管理模块

本模块负责小米账号认证与会话管理，包括：
- 小米账号登录
- Cookie管理
- 会话维护
- 设备ID更新
"""

import asyncio
import json
import os
import tempfile
import time

from aiohttp import ClientSession
from miservice import MiAccount, MiIOService, MiNAService

from xiaomusic.auth_diagnostics import AuthDiagnostics, error_fields, safe_endpoint
from xiaomusic.config import Device
from xiaomusic.const import COOKIE_TEMPLATE
from xiaomusic.utils.system_utils import (
    get_random,
    parse_cookie_string,
    parse_cookie_string_to_dict,
)

LOGIN_COOLDOWN_SEC = 30
INIT_LOCK_TIMEOUT_SEC = 60


class AuthManager:
    """认证管理器"""

    def __init__(self, config, log, device_manager):
        self.config = config
        self.log = log
        self.mi_token_home = os.path.join(self.config.conf_path, ".mi.token")

        self._init_lock = asyncio.Lock()
        self._last_login_time = 0
        self._last_login_ok = False
        self._consecutive_failures = 0

        self.mina_service = None
        self.miio_service = None
        self.login_acount = None
        self.login_password = None
        self.cookie_jar = None

        self._cur_did = None
        self.device_id = get_random(16).upper()
        self.mi_session = ClientSession(trace_configs=[self._get_diagnostics().trace_config()])
        self.device_manager = device_manager

    def _get_diagnostics(self):
        diagnostics = getattr(self, "_auth_diagnostics", None)
        if diagnostics is None:
            self._auth_diagnostics = diagnostics = AuthDiagnostics(self.config.conf_path)
        return diagnostics

    def record_auth_event(self, event, **fields):
        self._get_diagnostics().emit(event, **fields)

    def _instrument_account(self, account):
        if getattr(account, "_xiaomusic_auth_observed", False):
            return
        account._xiaomusic_auth_observed = True
        diagnostics = self._get_diagnostics()
        original_login = getattr(account, "login", None)
        original_service = getattr(account, "_serviceLogin", None)
        original_security = getattr(account, "_securityTokenService", None)

        if original_security:
            async def security_token(*args, **kwargs):
                diagnostics.emit("service_token_started", phase="security_token")
                try:
                    result = await original_security(*args, **kwargs)
                    diagnostics.emit("service_token_finished", phase="security_token", success=bool(result))
                    return result
                except Exception as exc:
                    diagnostics.emit("service_token_failed", phase="security_token", **error_fields(exc))
                    raise
            account._securityTokenService = security_token

        if original_service:
            async def service_login(uri, data=None):
                phase = uri.split("?", 1)[0].rsplit("/", 1)[-1]
                if phase not in ("serviceLogin", "serviceLoginAuth2"):
                    phase = "other"
                started = time.perf_counter()
                old_ua = getattr(account, "now_ua", None)
                try:
                    response = await original_service(uri, data)
                    fields = {"phase": phase, "elapsed_ms": round((time.perf_counter() - started) * 1000, 1)}
                    if isinstance(response, dict):
                        for source, target in (("code", "api_code"), ("securityStatus", "security_status")):
                            if isinstance(response.get(source), int):
                                fields[target] = response[source]
                        fields.update(has_captcha=bool(response.get("captchaUrl")),
                                      has_notification=bool(response.get("notificationUrl")),
                                      has_redirect=bool(response.get("location")),
                                      response_identity_present=bool(response.get("passToken") and response.get("userId")),
                                      response_pass_token_changed=bool(response.get("passToken")) and
                                      response.get("passToken") != (getattr(account, "token", None) or {}).get("passToken"))
                    fields["user_agent_changed"] = old_ua != getattr(account, "now_ua", None)
                    fields["after"] = diagnostics.snapshot(account)
                    diagnostics.emit("service_login_result", **fields)
                    return response
                except Exception as exc:
                    diagnostics.emit("service_login_error", phase=phase, **error_fields(exc))
                    raise
            account._serviceLogin = service_login

        if original_login:
            async def login(sid):
                with diagnostics.operation():
                    before = diagnostics.snapshot(account)
                    token = dict(getattr(account, "token", None) or {})
                    started = time.perf_counter()
                    success = False
                    safe_sid = sid if sid in ("micoapi", "xiaomiio", "xiaomihome") else "other"
                    diagnostics.emit("login_started", sid=safe_sid, before=before)
                    try:
                        result = await original_login(sid)
                        success = bool(result)
                        return result
                    except Exception as exc:
                        diagnostics.emit("login_exception", sid=safe_sid, **error_fields(exc))
                        raise
                    finally:
                        after = diagnostics.snapshot(account)
                        current = getattr(account, "token", None) or {}
                        diagnostics.emit(
                            "login_finished", sid=safe_sid, success=success,
                            elapsed_ms=round((time.perf_counter() - started) * 1000, 1),
                            before=before, after=after,
                            cache_file_removed=before["cache_file_present"] and not after["cache_file_present"],
                            pass_token_changed=token.get("passToken") != current.get("passToken"),
                            service_changed=token.get(sid) != current.get(sid),
                            device_identity_changed=token.get("deviceId") != current.get("deviceId"),
                        )
            account.login = login

    async def init_all_data(self, force_login=False):
        try:
            await asyncio.wait_for(
                self._init_all_data_with_lock(force_login),
                timeout=INIT_LOCK_TIMEOUT_SEC,
            )
        except asyncio.TimeoutError:
            self.record_auth_event("initialization_timeout")
            self.log.warning("init_all_data 超时，可能被其他调用持有锁")

    async def _init_all_data_with_lock(self, force_login=False):
        async with self._init_lock:
            await self._init_all_data_impl(force_login)

    async def _init_all_data_impl(self, force_login=False):
        self.record_auth_event("initialization_started", force_login=force_login,
                               service_available=self.mina_service is not None,
                               account_configured=bool(self.config.account),
                               password_configured=bool(self.config.password))
        self.mi_token_home = os.path.join(self.config.conf_path, ".mi.token")
        self.log.info(
            f"[AUTH] init_all_data 开始, "
            f"mina_service={'None' if self.mina_service is None else '已创建'}, "
            f"login_account_present={bool(self.login_acount)}, "
            f"configured_account_present={bool(self.config.account)}, "
            f"config.password={'***' if self.config.password else '(空)'}, "
            f"auth.json存在={os.path.isfile(os.path.join(self.config.conf_path, 'auth.json'))}, "
            f".mi.token存在={os.path.isfile(self.mi_token_home)}, "
            f"force_login={force_login}"
        )
        if force_login:
            is_need_login = True
            self.log.info("[AUTH] force_login=True，强制重新登录")
        else:
            is_need_login = await self.need_login()
        is_can_login = await self.can_login()
        self.log.info(f"[AUTH] need_login={is_need_login}, can_login={is_can_login}")
        if is_need_login and is_can_login:
            self.log.info("[AUTH] 需要登录，开始执行 login_miboy")
            login_ok = await self.login_miboy()
            if not login_ok:
                self.log.warning("[AUTH] 登录失败，本次初始化中止")
                self.record_auth_event("initialization_finished", success=False, service_available=False)
                return
        else:
            self.log.info(
                f"[AUTH] 无需登录 need_login:{is_need_login} can_login:{is_can_login}"
            )
        await self.device_manager.update_device_info(self)
        cookie_jar = self.get_cookie()
        if cookie_jar:
            self.mi_session.cookie_jar.update_cookies(cookie_jar)
            self.log.info("[AUTH] cookie 已更新到 session")
        else:
            self.log.warning("[AUTH] get_cookie 返回 None，cookie 未更新")
        self.cookie_jar = self.mi_session.cookie_jar
        self.record_auth_event("initialization_finished", success=self.mina_service is not None,
                               service_available=self.mina_service is not None,
                               cookie_count=len(self.cookie_jar))

    async def can_login(self):
        if self.config.account and self.config.password:
            return True
        if self.get_cookie():
            return True
        if os.path.isfile(os.path.join(self.config.conf_path, "auth.json")):
            return True
        self.log.warning("没有账号密码 或 cookies 无法登陆")
        return False

    async def need_login(self):
        if self.mina_service is None:
            self.log.info("[AUTH-NEED] mina_service 为 None，需要登录")
            return True
        if self.login_acount != self.config.account:
            self.log.info(
                "[AUTH-NEED] 账号变更，需要登录: "
                "已隐藏账号标识"
            )
            return True
        if self.login_password != self.config.password:
            self.log.info("[AUTH-NEED] 密码变更，需要登录")
            return True

        elapsed = time.time() - self._last_login_time
        if self._last_login_ok and elapsed < LOGIN_COOLDOWN_SEC:
            self.log.debug(
                f"[AUTH-NEED] 冷却期内({elapsed:.0f}s/{LOGIN_COOLDOWN_SEC}s)，跳过"
            )
            return False

        self.log.debug("[AUTH-NEED] 检查 device_list() 是否可用...")
        try:
            result = await self.mina_service.device_list()
            self.log.debug(f"[AUTH-NEED] device_list() 成功，返回 {len(result)} 个设备")
        except Exception as e:
            error_str = str(e)
            is_70016 = "70016" in error_str or "登录验证失败" in error_str
            if is_70016:
                self.log.warning(
                    f"[AUTH-NEED] device_list() 返回 70016(登录验证失败): {type(e).__name__}"
                )
            else:
                self.log.warning(f"[AUTH-NEED] device_list() 异常: {type(e).__name__}")
            if self._last_login_ok and elapsed < LOGIN_COOLDOWN_SEC * 2:
                self.log.warning(
                    "[AUTH-NEED] 最近登录成功但API调用失败，"
                    "可能是临时网络问题，暂不重新登录"
                )
                return False
            return True
        return False

    async def login_miboy(self):
        self.log.info(
            f"[AUTH-LOGIN] 开始登录, account_present={bool(self.config.account)}"
        )
        try:
            mi_account = MiAccount(
                self.mi_session,
                self.config.account,
                self.config.password,
                str(self.mi_token_home),
            )
            self._instrument_account(mi_account)

            self.set_token(mi_account)
            token_info = mi_account.token
            self.log.info(
                f"[AUTH-LOGIN] MiAccount 创建成功, "
                f"token keys={list(token_info.keys()) if token_info else 'None'}, "
                f"has_passToken={'passToken' in (token_info or {})}, "
                f".mi.token存在={os.path.isfile(self.mi_token_home)}"
            )

            login_result = await self._cached_speaker_ready(mi_account)
            if not login_result:
                # A rejected service token needs a fresh identity, not repeated
                # reuse of the same cache. A valid one must never be discarded
                # merely because its older passToken cannot log in again.
                before_reset = self._get_diagnostics().snapshot(mi_account)
                mi_account.token = None
                self.record_auth_event("identity_reset", source="cache_rejected", before=before_reset,
                                       after=self._get_diagnostics().snapshot(mi_account))
                self.set_token(mi_account)
                login_result = await mi_account.login("micoapi")
            self.log.info(
                f"[AUTH-LOGIN] mi_account.login('micoapi') 返回: {login_result}"
            )

            if not login_result:
                self._consecutive_failures += 1
                self.log.warning(
                    f"[AUTH-LOGIN] login 返回 False "
                    f"(连续失败次数: {self._consecutive_failures})"
                )

                refreshed = await self._try_fresh_session_and_relogin(mi_account)
                if refreshed:
                    self.log.info("[AUTH-LOGIN] 使用全新 session 重新登录后成功")
                    return True
                else:
                    self.mina_service = None
                    self.miio_service = None
                    self._last_login_ok = False
                    self._last_login_time = time.time()
                    self.log.warning(
                        "[AUTH-LOGIN] 最终登录失败，"
                        "passToken 可能已过期或被吊销，"
                        "建议重新扫码登录或检查网络"
                    )
                    return False

            self._consecutive_failures = 0
            self._persist_qr_identity(mi_account)
            self.mina_service = MiNAService(mi_account)
            self.miio_service = MiIOService(mi_account)
            self._patch_account(mi_account)
            self.login_acount = self.config.account
            self.login_password = self.config.password
            self._last_login_ok = True
            self._last_login_time = time.time()
            self.log.info("[AUTH-LOGIN] 登录完成")
            return True

        except KeyError as e:
            self.record_auth_event("login_setup_failed", phase="login_miboy", **error_fields(e))
            self._consecutive_failures += 1
            self.mina_service = None
            self.miio_service = None
            self._last_login_ok = False
            self._last_login_time = time.time()
            self.log.warning(
                f"[AUTH-LOGIN] KeyError(API响应格式错误): {type(e).__name__}，"
                "建议使用Cookie登录或访问小米官网验证"
            )
            return False
        except Exception as e:
            self.record_auth_event("login_setup_failed", phase="login_miboy", **error_fields(e))
            self._consecutive_failures += 1
            error_str = str(e)
            is_70016 = "70016" in error_str or "登录验证失败" in error_str
            self.mina_service = None
            self.miio_service = None
            self._last_login_ok = False
            self._last_login_time = time.time()
            if is_70016:
                self.log.warning(
                    f"[AUTH-LOGIN] 70016 错误(登录验证失败): {type(e).__name__}，"
                    "passToken 在 micoapi 服务端可能已被吊销"
                )
            else:
                self.log.warning(f"[AUTH-LOGIN] 异常: {type(e).__name__}")
            return False

    async def _try_fresh_session_and_relogin(self, old_mi_account):
        self.log.info("[AUTH-FRESH] 尝试使用全新 session 重新登录...")
        try:
            old_session = self.mi_session
            new_session = ClientSession(trace_configs=[self._get_diagnostics().trace_config()])

            new_account = MiAccount(
                new_session,
                self.config.account,
                self.config.password,
                str(self.mi_token_home),
            )
            self._instrument_account(new_account)
            self.set_token(new_account)

            new_token = new_account.token
            old_token = old_mi_account.token
            self.log.info(
                f"[AUTH-FRESH] 新 MiAccount token keys="
                f"{list(new_token.keys()) if new_token else 'None'}, "
                f"旧 token keys={list(old_token.keys()) if old_token else 'None'}"
            )

            result = await new_account.login("micoapi")
            self.log.info(f"[AUTH-FRESH] 新 session login 结果: {result}")

            if result:
                self._persist_qr_identity(new_account)
                self.log.info("[AUTH-FRESH] 替换为新 session 和 account")
                await old_session.close()
                self.mi_session = new_session
                self.mina_service = MiNAService(new_account)
                self.miio_service = MiIOService(new_account)
                self._patch_account(new_account)
                self.login_acount = self.config.account
                self.login_password = self.config.password
                self._last_login_ok = True
                self._last_login_time = time.time()
                self._consecutive_failures = 0
                return True
            else:
                self.log.warning("[AUTH-FRESH] 新 session 也失败了，关闭新 session")
                await new_session.close()
                return False

        except Exception as e:
            self.log.warning(f"[AUTH-FRESH] 过程异常: {type(e).__name__}")
            return False

    async def _cached_speaker_ready(self, account):
        """Validate cached service access without triggering SDK re-login."""
        if not (account.token or {}).get("micoapi"):
            return False
        original = account.mi_request

        async def without_relogin(sid, url, data, headers, relogin=True):
            return await original(sid, url, data, headers, False)

        account.mi_request = without_relogin
        diagnostics = self._get_diagnostics()
        with diagnostics.operation():
            diagnostics.emit("cache_validation_started", before=diagnostics.snapshot(account))
            try:
                await MiNAService(account).device_list()
                diagnostics.emit("cache_validation_finished", success=True, after=diagnostics.snapshot(account))
                self.log.info("[AUTH] Reusing validated speaker service session")
                return True
            except Exception as exc:
                diagnostics.emit("cache_validation_finished", success=False,
                                 after=diagnostics.snapshot(account), **error_fields(exc))
                self.log.info(
                    "[AUTH] Cached speaker session rejected: %s", type(exc).__name__
                )
                return False
            finally:
                account.mi_request = original

    def _patch_account(self, mi_account):
        self._instrument_account(mi_account)
        diagnostics = self._get_diagnostics()
        original_mi_request = mi_account.mi_request
        auth_manager = self

        async def request_with_recovery(sid, url, data, headers, relogin=True):
            try:
                result = await original_mi_request(sid, url, data, headers, relogin)
                auth_manager._persist_qr_identity(mi_account)
                return result
            except Exception as exc:
                if not relogin:
                    raise
                error_msg = str(exc)
                # Device/transport failures do not invalidate the account.
                # Re-login on a remote-control timeout can destroy a valid
                # service cache when its older passToken cannot be reused.
                if not any(
                    marker in error_msg.lower()
                    for marker in ("login failed", "auth", "401", "70016")
                ):
                    raise
                auth_manager.log.warning(
                    f"[PATCH-mi_request] mi_request 失败: {type(exc).__name__}, "
                    f"尝试从 auth.json 恢复 passToken 后重试..."
                )

                mi_account.session.cookie_jar.clear()
                auth_manager.log.info("[PATCH-mi_request] 已清理 session cookie jar")

                auth_manager.set_token(mi_account)
                if mi_account.token and "passToken" in mi_account.token:
                    try:
                        login_ok = await mi_account.login(sid)
                        if login_ok:
                            auth_manager._persist_qr_identity(mi_account)
                            auth_manager.log.info(
                                "[PATCH-mi_request] 恢复 passToken 后重新登录成功，重试原始请求"
                            )
                            return await original_mi_request(
                                sid, url, data, headers, False
                            )
                        else:
                            auth_manager.log.warning(
                                "[PATCH-mi_request] 恢复 passToken 后 login 仍返回 False"
                            )
                    except Exception as e2:
                        auth_manager.log.warning(
                            f"[PATCH-mi_request] 恢复 passToken 后重新登录异常: {type(e2).__name__}"
                        )
                else:
                    auth_manager.log.warning(
                        "[PATCH-mi_request] auth.json 中无有效 passToken，无法恢复"
                    )
                raise

        async def patched_mi_request(sid, url, data, headers, relogin=True):
            with diagnostics.operation():
                before = diagnostics.snapshot(mi_account)
                started = time.perf_counter()
                success = False
                diagnostics.emit("service_request_started", endpoint=safe_endpoint(url), before=before)
                try:
                    result = await request_with_recovery(sid, url, data, headers, relogin)
                    success = True
                    return result
                except Exception as exc:
                    diagnostics.emit("service_request_failed", endpoint=safe_endpoint(url), **error_fields(exc))
                    raise
                finally:
                    diagnostics.emit("service_request_finished", endpoint=safe_endpoint(url),
                                     success=success, before=before, after=diagnostics.snapshot(mi_account),
                                     elapsed_ms=round((time.perf_counter() - started) * 1000, 1))

        mi_account.mi_request = patched_mi_request

    async def try_update_device_id(self):
        try:
            mi_dids = self.config.mi_did.split(",")
            hardware_data = await self.mina_service.device_list()
            devices = {}
            for h in hardware_data:
                device_id = h.get("deviceID", "")
                hardware = h.get("hardware", "")
                did = h.get("miotDID", "")
                name = h.get("alias", "")
                if not name:
                    name = h.get("name", "未知名字")
                if device_id and hardware and did:
                    if not mi_dids or not mi_dids[0] or (did in mi_dids):
                        device = self.config.devices.get(did, Device())
                        device.did = did
                        self._cur_did = did
                        device.device_id = device_id
                        device.hardware = hardware
                        device.name = name
                        devices[did] = device
            self.config.devices = devices
            self.log.info(f"[AUTH] 选中的设备: {devices}")
            return devices
        except Exception as e:
            self.log.warning(f"[AUTH] try_update_device_id 失败: {type(e).__name__}")
            return {}

    def set_token(self, account):
        auth_path = os.path.join(self.config.conf_path, "auth.json")
        if os.path.isfile(auth_path):
            try:
                with open(auth_path, encoding="utf-8") as f:
                    user_data = json.loads(f.read())
                    cached = account.token or {}
                    same_user = str(cached.get("userId")) == str(
                        user_data.get("userId")
                    )
                    newer_cache = os.path.isfile(self.mi_token_home) and (
                        os.path.getmtime(self.mi_token_home)
                        > os.path.getmtime(auth_path)
                    )
                    if (
                        same_user
                        and cached.get("passToken")
                        and (
                            cached["passToken"] == user_data.get("passToken")
                            or newer_cache
                        )
                    ):
                        self.device_id = cached.get("deviceId", self.device_id)
                        self.record_auth_event("identity_selected", source="sdk_cache",
                                               after=self._get_diagnostics().snapshot(account))
                        return
                    self.device_id = user_data["deviceId"]
                    account.token = {
                        "passToken": user_data["passToken"],
                        "userId": user_data["userId"],
                        "deviceId": self.device_id,
                    }
                    self.record_auth_event("identity_selected", source="qr_file",
                                           after=self._get_diagnostics().snapshot(account))
                    self.log.debug(
                        f"[AUTH-set_token] 从 auth.json 加载 token, "
                        "identity_present=True, "
                        f"device_id_present={bool(self.device_id)}"
                    )
            except Exception as e:
                self.log.error(f"[AUTH-set_token] 读取 auth.json 失败: {type(e).__name__}")
        elif self.config.cookie:
            cookies_dict = parse_cookie_string_to_dict(self.config.cookie)
            account.token = {
                "passToken": cookies_dict["passToken"],
                "userId": cookies_dict["userId"],
                "deviceId": self.device_id,
            }
            self.record_auth_event("identity_selected", source="configured_cookie",
                                   after=self._get_diagnostics().snapshot(account))
            self.log.debug("[AUTH-set_token] 从 cookie 配置加载 token")
        else:
            self.log.warning(
                "[AUTH-set_token] 无 auth.json 且无 cookie 配置，无法设置 token"
            )

    def _persist_qr_identity(self, account):
        """Keep the shared identity current when the SDK rotates its passToken."""
        auth_path = os.path.join(self.config.conf_path, "auth.json")
        token = account.token or {}
        pending = None
        try:
            if not os.path.isfile(auth_path) or not token.get("passToken"):
                return
            with open(auth_path, encoding="utf-8") as f:
                saved = json.load(f)
            if str(saved.get("userId")) != str(token.get("userId")):
                return
            fields = ("userId", "passToken", "deviceId")
            if all(saved.get(key) == token.get(key) for key in fields):
                return
            saved.update({key: token[key] for key in fields})
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=self.config.conf_path, delete=False
            ) as f:
                pending = f.name
                json.dump(saved, f, ensure_ascii=False, indent=2)
            os.replace(pending, auth_path)
            pending = None
            self.record_auth_event("qr_identity_persisted", after=self._get_diagnostics().snapshot(account))
        except Exception as exc:
            self.log.warning(
                "Persisting refreshed QR identity failed: %s", type(exc).__name__
            )
        finally:
            if pending is not None:
                os.unlink(pending)

    def get_cookie(self):
        if self.config.cookie:
            cookie_jar = parse_cookie_string(self.config.cookie)
            return cookie_jar

        if not os.path.exists(self.mi_token_home):
            self.log.warning(f"[AUTH-get_cookie] {self.mi_token_home} 不存在")
            cookie_jar = self._get_cookie_from_session()
            if cookie_jar:
                return cookie_jar
            return None

        try:
            with open(self.mi_token_home, encoding="utf-8") as f:
                user_data = json.loads(f.read())
            self.log.info("[AUTH-get_cookie] .mi.token 文件加载成功")
            user_id = user_data.get("userId")
            service_token = user_data.get("micoapi")[1]
            device_id = self.config.get_one_device_id()
            cookie_string = COOKIE_TEMPLATE.format(
                device_id=device_id, service_token=service_token, user_id=user_id
            )
            return parse_cookie_string(cookie_string)
        except Exception as e:
            self.log.warning(f"[AUTH-get_cookie] 读取 .mi.token 失败: {type(e).__name__}")
            cookie_jar = self._get_cookie_from_session()
            if cookie_jar:
                return cookie_jar
            return None

    def _get_cookie_from_session(self):
        if self.mina_service is None:
            return None
        account = self.mina_service.account
        if not account or not account.token:
            return None
        token = account.token
        micoapi_data = token.get("micoapi")
        if not micoapi_data or len(micoapi_data) < 2:
            self.log.warning("[AUTH-get_cookie] 内存 token 中缺少 micoapi 数据")
            return None
        user_id = token.get("userId")
        service_token = micoapi_data[1]
        device_id = self.config.get_one_device_id()
        if not user_id or not service_token:
            self.log.warning(
                "[AUTH-get_cookie] 内存 token 中缺少 userId 或 serviceToken"
            )
            return None
        self.log.info("[AUTH-get_cookie] 从内存 token 降级获取 cookie")
        cookie_string = COOKIE_TEMPLATE.format(
            device_id=device_id, service_token=service_token, user_id=user_id
        )
        return parse_cookie_string(cookie_string)
