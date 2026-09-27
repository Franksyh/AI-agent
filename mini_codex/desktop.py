"""Windows companion: a draggable desktop robot and an Edge app window."""
from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import tkinter as tk
from tkinter import filedialog
import webbrowser

from server import DATA, start


class Desktop:
    BASE_WIDTH = 230
    BASE_HEIGHT = 210
    SIZES = (75, 100, 125, 150)

    def __init__(self, server, root=None):
        self.server = server
        self.root = root or tk.Tk()
        self.server.attach_desktop()
        self.preferences = DATA / 'desktop.json'
        self.scale_percent = self._load_scale()
        self.scale = self.scale_percent / 100
        self.root.title('Mini Codex')
        self.root.overrideredirect(True)
        self.root.attributes('-topmost', True)
        self.root.configure(bg='#ff00ff')
        if os.name == 'nt':
            self.root.wm_attributes('-transparentcolor', '#ff00ff')
        self.canvas = tk.Canvas(self.root, bg='#ff00ff', highlightthickness=0)
        self.canvas.pack()
        self._place_initially()
        self.draw_robot()
        self.canvas.bind('<ButtonPress-1>', self.press)
        self.canvas.bind('<B1-Motion>', self.drag)
        self.canvas.bind('<ButtonRelease-1>', self.release)
        self.menu = tk.Menu(self.root, tearoff=False)
        self.menu.add_command(label='開啟桌面工作台', command=self.open_app)
        self.menu.add_command(label='開啟網頁版', command=lambda: webbrowser.open(self.server.url))
        self.menu.add_command(label='複製網頁版連結', command=self.copy_url)
        self.menu.add_command(label='隱藏 Mini', command=self.hide)
        self.menu.add_command(label='顯示 Mini', command=self.show)
        size_menu = tk.Menu(self.menu, tearoff=False)
        for percent in self.SIZES:
            size_menu.add_command(label=f'{percent}%', command=lambda p=percent: self.set_scale(p))
        self.menu.add_cascade(label='Mini 大小', menu=size_menu)
        self.menu.add_separator()
        self.menu.add_command(label='結束 Mini Codex', command=self.quit)
        self.canvas.bind('<Button-3>', lambda e: self.menu.tk_popup(e.x_root, e.y_root))
        self.root.protocol('WM_DELETE_WINDOW', self.quit)
        self.tick()

    def _load_scale(self):
        try:
            value = json.loads(self.preferences.read_text(encoding='utf-8')).get('scale', 100)
            return int(value) if int(value) in self.SIZES else 100
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return 100

    def _save_scale(self):
        try:
            DATA.mkdir(parents=True, exist_ok=True)
            self.preferences.write_text(json.dumps({'scale': self.scale_percent}), encoding='utf-8')
        except OSError:
            # A cosmetic setting must never stop the assistant from opening.
            pass

    @property
    def width(self):
        return round(self.BASE_WIDTH * self.scale)

    @property
    def height(self):
        return round(self.BASE_HEIGHT * self.scale)

    def _place_initially(self):
        x = max(0, self.root.winfo_screenwidth() - self.width - 240)
        y = max(0, self.root.winfo_screenheight() - self.height - 70)
        self.root.geometry(f'{self.width}x{self.height}+{x}+{y}')
        self.canvas.configure(width=self.width, height=self.height)

    def _coords(self, *values):
        return tuple(round(value * self.scale) for value in values)

    def draw_robot(self):
        c = self.canvas
        c.delete('all')
        xy = self._coords
        c.create_rectangle(*xy(8, 9, 220, 49), fill='#ffffff', outline='#e1e5ef', width=max(1, round(self.scale)))
        self.label = c.create_text(*xy(114, 29), text='Mini Codex · 準備開始', fill='#555f79',
                                   font=('Microsoft JhengHei', max(8, round(10 * self.scale))))
        c.create_oval(*xy(68, 186, 192, 197), fill='#d9deed', outline='')
        c.create_line(*xy(129, 79, 129, 66), fill='#4f66d7', width=max(2, round(5 * self.scale)))
        c.create_oval(*xy(123, 57, 136, 70), fill='#97efd5', outline='#5c78d9')
        c.create_oval(*xy(84, 130, 174, 185), fill='#647af0', outline='#334dba', width=max(1, round(2 * self.scale)))
        c.create_oval(*xy(78, 170, 109, 193), fill='#536de1', outline='#334dba', width=max(1, round(2 * self.scale)))
        c.create_oval(*xy(149, 171, 180, 194), fill='#536de1', outline='#334dba', width=max(1, round(2 * self.scale)))
        c.create_oval(*xy(69, 98, 94, 132), fill='#6782f4', outline='#334dba', width=max(1, round(2 * self.scale)))
        c.create_oval(*xy(165, 98, 187, 132), fill='#6782f4', outline='#334dba', width=max(1, round(2 * self.scale)))
        c.create_oval(*xy(80, 74, 178, 155), fill='#738afa', outline='#334dba', width=max(1, round(2 * self.scale)))
        c.create_rectangle(*xy(94, 100, 165, 134), fill='#233775', outline='#253672', width=max(1, round(3 * self.scale)))
        c.create_line(*xy(107, 109, 116, 117, 107, 124), fill='#9cf5d8', width=max(2, round(4 * self.scale)))
        c.create_line(*xy(127, 124, 140, 124), fill='#9cf5d8', width=max(2, round(4 * self.scale)))
        c.create_polygon(*xy(140, 146, 190, 141, 185, 174, 139, 177), fill='#223575', outline='#132550', width=max(1, round(2 * self.scale)))
        c.create_line(*xy(159, 153, 166, 158, 158, 164), fill='#9cf5d8', width=max(1, round(3 * self.scale)))
        c.create_line(*xy(132, 180, 189, 177), fill='#304882', width=max(2, round(5 * self.scale)))
        c.create_oval(*xy(77, 147, 99, 171), fill='#7188f4', outline='#334dba', width=max(1, round(2 * self.scale)))

    def set_scale(self, percent):
        if percent not in self.SIZES:
            return
        x, y = self.root.winfo_x(), self.root.winfo_y()
        self.scale_percent = percent
        self.scale = percent / 100
        x = max(0, min(self.root.winfo_screenwidth() - self.width, x))
        y = max(0, min(self.root.winfo_screenheight() - self.height, y))
        self.canvas.configure(width=self.width, height=self.height)
        self.root.geometry(f'{self.width}x{self.height}+{x}+{y}')
        self.draw_robot()
        self._save_scale()

    def press(self, event):
        self.drag_start = (event.x_root, event.y_root, self.root.winfo_x(), self.root.winfo_y())
        self.moved = False

    def drag(self, event):
        sx, sy, wx, wy = self.drag_start
        dx, dy = event.x_root - sx, event.y_root - sy
        if abs(dx) + abs(dy) > 5:
            self.moved = True
        x = max(0, min(self.root.winfo_screenwidth() - self.width, wx + dx))
        y = max(0, min(self.root.winfo_screenheight() - self.height, wy + dy))
        self.root.geometry(f'+{x}+{y}')

    def release(self, _event):
        if not self.moved:
            self.open_app()

    def copy_url(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.server.url)

    def hide(self):
        self.root.withdraw()

    def show(self):
        self.root.deiconify()
        self.root.lift()
        self.root.attributes('-topmost', True)

    def open_app(self):
        candidates = [Path(os.environ.get(key, '')) / 'Microsoft/Edge/Application/msedge.exe'
                      for key in ('ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA')]
        edge = next((p for p in candidates if p.is_file()), None)
        if edge:
            subprocess.Popen([str(edge), '--app=' + self.server.url, '--window-size=1360,900',
                '--user-data-dir=' + str(DATA / 'browser'), '--no-first-run'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            webbrowser.open(self.server.url)

    @staticmethod
    def _text_preview(path):
        """Return a bounded UTF-8 preview for clearly textual, small files."""
        mime = mimetypes.guess_type(path.name)[0] or ''
        textual_suffixes = {
            '.c', '.cc', '.cpp', '.css', '.csv', '.go', '.h', '.html', '.java',
            '.js', '.json', '.md', '.mjs', '.py', '.rs', '.sh', '.sql', '.svg',
            '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
        }
        if not (mime.startswith('text/') or mime in {'application/json', 'application/xml'} or
                path.suffix.lower() in textual_suffixes):
            return None
        if path.stat().st_size > 1024 * 1024:
            return None
        raw = path.read_bytes()[:8192]
        if b'\x00' in raw:
            return None
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            return None
        text = text.replace('\r\n', '\n').replace('\r', '\n').strip()
        return text[:1200] or None

    @staticmethod
    def _open_with_default_app(path):
        """Open a user-selected regular file without invoking a shell."""
        if hasattr(os, 'startfile'):
            os.startfile(str(path))  # type: ignore[attr-defined]  # Windows shell association
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', '--', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen(['xdg-open', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def choose_and_open_file(self, request):
        """Use a native picker; no pathname can originate in browser input."""
        try:
            selected = filedialog.askopenfilename(
                parent=self.root,
                title='選擇要用預設應用程式開啟的檔案',
            )
        except tk.TclError:
            self.server.record_file_result({
                'status': 'failed',
                'message': '系統檔案選擇器無法開啟。',
            })
            return
        if not selected:
            self.server.record_file_result({
                'status': 'cancelled',
                'message': '未選取檔案，沒有開啟任何內容。',
            })
            return

        try:
            path = Path(selected).resolve(strict=True)
            if not path.is_file():
                raise ValueError('請選擇一般檔案')
            stat = path.stat()
            result = {
                'status': 'opened',
                'message': f'已用預設應用程式開啟「{path.name}」。',
                'name': path.name,
                'size': stat.st_size,
                'mime': mimetypes.guess_type(path.name)[0] or 'unknown',
            }
            if request.get('includePreview') is True:
                preview = self._text_preview(path)
                if preview:
                    result['preview'] = preview
                else:
                    result['message'] += ' 此檔案沒有可安全顯示的文字預覽。'
            self._open_with_default_app(path)
            self.server.record_file_result(result)
        except (OSError, ValueError) as exc:
            self.server.record_file_result({
                'status': 'failed',
                'message': f'無法開啟選取的檔案：{str(exc)[:180]}',
            })

    def tick(self):
        request = self.server.take_desktop_request()
        if request == 'show':
            self.show()
        elif request == 'hide':
            self.hide()
        file_request = self.server.take_file_request()
        if file_request:
            self.choose_and_open_file(file_request)
        state = self.server.assistant.state()
        status = ('等待你的核准' if state['approvals'] else '正在處理任務…' if state['busy'] else
                  '連線中／請查看工作台' if not state['ready'] else
                  '請先登入 Codex' if not state['account'] else '點我開始工作')
        self.canvas.itemconfigure(self.label, text='Mini · ' + status)
        self.root.after(700, self.tick)

    def quit(self):
        self.server.detach_desktop()
        self.server.assistant.bridge.close()
        self.server.shutdown()
        self.root.destroy()


if __name__ == '__main__':
    server = start()
    desktop = Desktop(server)
    desktop.open_app()
    desktop.root.mainloop()
