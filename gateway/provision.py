"""TTS Service 初始化 / 调整工具（部署时用，一次性脚本）。

用法（在 gatewary 目录下，用服务器上的 GPT-SoVITS 运行时 Python 执行）：

    python provision.py --list
    python provision.py --host 0.0.0.0 --port 18080 --public-base-url http://192.168.1.166:18080 \
        --admin-password 'xxxx' --key-name hub --key-note 'Absolute Solver Hub'

行为：
  * 读 config.json（不存在则新建，并迁移旧的 gateway_state.json 音色表）；
  * `--admin-password` 只在尚未设置口令时写入；要覆盖必须加 `--reset-admin`；
  * `--key-name` 指定的密钥不存在时创建一把并打印明文（只打印这一次）；
  * 只写磁盘，不启动服务。改监听地址/端口后需要重启服务。
"""

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import gateway as svc  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="初始化 TTS Service 配置")
    parser.add_argument("--host", choices=["0.0.0.0", "127.0.0.1"], default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--public-base-url", default=None)
    parser.add_argument("--admin-password", default=None)
    parser.add_argument("--reset-admin", action="store_true")
    parser.add_argument("--key-name", default=None)
    parser.add_argument("--key-note", default="")
    parser.add_argument("--default-voice", default=None, help="把某个已注册音色设为默认")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    cfg = svc.bootstrap_config()
    changed = False

    if args.default_voice:
        if args.default_voice not in (cfg.get("voices") or {}):
            print(f"音色不存在，未设置默认: {args.default_voice}")
        elif cfg["defaults"].get("voice") != args.default_voice:
            cfg["defaults"]["voice"] = args.default_voice
            print(f"默认音色已设为 {args.default_voice}")
            changed = True
        else:
            print(f"默认音色已是 {args.default_voice}")

    if args.host:
        cfg["server"]["host"] = args.host
        changed = True
    if args.port:
        cfg["server"]["port"] = args.port
        changed = True
    if args.public_base_url:
        cfg["server"]["public_base_url"] = args.public_base_url.rstrip("/")
        changed = True

    if args.admin_password:
        if cfg["auth"].get("admin_password_hash") and not args.reset_admin:
            print("管理员口令已存在，未修改（需要覆盖请加 --reset-admin）")
        else:
            cfg["auth"]["admin_password_hash"] = svc.hash_password(args.admin_password)
            print("管理员口令已写入")
            changed = True

    if args.key_name:
        existing = next(
            (k for k in (cfg.get("keys") or []) if k.get("name") == args.key_name), None
        )
        if existing is None:
            record = svc._new_key_record(args.key_name, args.key_note)
            cfg.setdefault("keys", []).append(record)
            changed = True
            print(f"已创建客户端密钥 [{record['name']}]: {record['key']}")
        else:
            print(f"密钥 [{args.key_name}] 已存在，未修改: {svc._mask(existing.get('key') or '')}")

    if changed:
        svc.save_config(cfg)

    print("--- 当前配置 ---")
    print(f"配置文件    : {svc.CONFIG_PATH}")
    print(f"监听        : {cfg['server']['host']}:{cfg['server']['port']}")
    print(f"对外地址    : {cfg['server'].get('public_base_url') or '（按请求推断）'}")
    print(f"上游        : {svc.upstream_base(cfg)}")
    print(f"安装目录    : {svc.INSTALL or '未找到'}")
    print(f"管理员口令  : {'已设置' if cfg['auth'].get('admin_password_hash') else '未设置'}")
    print(f"音色        : {len(cfg.get('voices') or {})} 个，默认 {cfg['defaults'].get('voice')}")
    if cfg.get("keys"):
        print("客户端密钥  :")
        for record in cfg["keys"]:
            state = "启用" if record.get("enabled", True) else "停用"
            print(
                f"  - {record.get('name')} [{state}] {svc._mask(record.get('key') or '')}"
                f" 调用 {record.get('uses') or 0} 次"
            )
    else:
        print("客户端密钥  : 无（非回环地址将拒绝启动）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
