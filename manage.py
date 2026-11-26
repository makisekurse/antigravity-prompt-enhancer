# -*- coding: utf-8 -*-
"""提示词增强器 (Prompt Enhancer) 插件安装、热启动、卸载与状态管理工具。"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

SOURCE = Path(__file__).resolve().parent
HOME = Path.home()
PLUGIN_DIR = HOME / '.gemini' / 'config' / 'plugins' / 'prompt-enhancer'
DATA_DIR = HOME / '.gemini' / 'antigravity' / 'sidecar_data' / 'prompt-enhancer' / 'enhancer' / 'data'
OWNER_FILE = DATA_DIR / 'active-sidecar.json'
RUNTIME_ITEMS = ('plugin.json', 'README.md', 'assets', 'sidecars', 'skills')


def is_pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def find_node_executable():
    found = shutil.which('node')
    if found:
        return found
    if sys.platform == 'win32':
        candidates = [
            Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'nodejs' / 'node.exe',
            Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs' / 'nodejs' / 'node.exe',
        ]
        for c in candidates:
            if c.is_file():
                return str(c)
    return 'node'


def copy_plugin_files():
    PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
    for name in RUNTIME_ITEMS:
        src = SOURCE / name
        dst = PLUGIN_DIR / name
        if not src.exists():
            continue
        if src.resolve() == dst.resolve():
            continue
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.log'))
        else:
            shutil.copy2(src, dst)


def start_hot_daemon():
    main_mjs = PLUGIN_DIR / 'sidecars' / 'enhancer' / 'main.mjs'
    if not main_mjs.exists():
        return False
    creationflags = 0
    if sys.platform == 'win32':
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    subprocess.Popen(
        [find_node_executable(), str(main_mjs)],
        cwd=str(main_mjs.parent),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )
    return True


def signal_shutdown():
    """通知运行中的守护进程自动清理页面注入控件并退出。"""
    if not OWNER_FILE.is_file():
        return
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        OWNER_FILE.write_text(json.dumps({'shutdown': True, 'at': int(time.time() * 1000)}) + '\n', encoding='utf-8')
        time.sleep(2.8)
    except Exception:
        pass


def install():
    copy_plugin_files()
    started = start_hot_daemon()
    print(f'已安装插件至: {PLUGIN_DIR}')
    if started:
        print('已热启动内嵌提示词增强守护进程（无需重启客户端即可立即使用，后续客户端启动将由官方 Sidecar 自动拉起）。')


def uninstall():
    signal_shutdown()
    if PLUGIN_DIR.exists():
        shutil.rmtree(PLUGIN_DIR)
        print(f'已卸载插件目录并清理运行中控件: {PLUGIN_DIR}')
    else:
        print('插件尚未安装。')


def status():
    installed = (PLUGIN_DIR / 'plugin.json').is_file()
    owner = None
    running = False
    if OWNER_FILE.is_file():
        try:
            owner = json.loads(OWNER_FILE.read_text(encoding='utf-8'))
            running = bool(owner and not owner.get('shutdown') and is_pid_alive(owner.get('pid')))
        except Exception:
            owner = None
    print(json.dumps({
        'installed': installed,
        'running': running,
        'pluginDirectory': str(PLUGIN_DIR),
        'sourceDirectory': str(SOURCE),
        'activeSidecar': owner,
    }, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description='Prompt Enhancer 插件管理器')
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('install')
    sub.add_parser('uninstall')
    sub.add_parser('status')
    args = parser.parse_args()
    if args.action == 'install':
        install()
    elif args.action == 'uninstall':
        uninstall()
    elif args.action == 'status':
        status()


if __name__ == '__main__':
    main()
