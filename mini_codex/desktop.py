"""Windows companion: a draggable desktop robot and an Edge app window."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tkinter as tk
import webbrowser

from server import DATA, start


class Desktop:
    def __init__(self, server, root=None):
        self.server = server
        self.root = root or tk.Tk()
        self.root.title('Mini Codex')
        self.root.overrideredirect(True)
        self.root.attributes('-topmost', True)
        self.root.configure(bg='#ff00ff')
        if os.name == 'nt':
            self.root.wm_attributes('-transparentcolor', '#ff00ff')
        self.root.geometry(f'230x210+{max(0, self.root.winfo_screenwidth()-470)}+{max(0, self.root.winfo_screenheight()-280)}')
        self.canvas = tk.Canvas(self.root, width=230, height=210, bg='#ff00ff', highlightthickness=0)
        self.canvas.pack()
        self.draw_robot()
        self.canvas.bind('<ButtonPress-1>', self.press)
        self.canvas.bind('<B1-Motion>', self.drag)
        self.canvas.bind('<ButtonRelease-1>', self.release)
        self.menu = tk.Menu(self.root, tearoff=False)
        self.menu.add_command(label='開啟桌面工作台', command=self.open_app)
        self.menu.add_command(label='開啟網頁版', command=lambda: webbrowser.open(self.server.url))
        self.menu.add_command(label='複製網頁版連結', command=self.copy_url)
        self.menu.add_command(label='隱藏 Mini（重新啟動可顯示）', command=self.hide)
        self.menu.add_separator()
        self.menu.add_command(label='結束 Mini Codex', command=self.quit)
        self.canvas.bind('<Button-3>', lambda e: self.menu.tk_popup(e.x_root, e.y_root))
        self.root.protocol('WM_DELETE_WINDOW', self.quit)
        self.tick()

    def draw_robot(self):
        c = self.canvas
        c.create_rectangle(8, 9, 220, 49, fill='#ffffff', outline='#e1e5ef', width=1)
        self.label = c.create_text(114, 29, text='Mini Codex · 準備開始', fill='#555f79', font=('Microsoft JhengHei', 10))
        c.create_oval(68, 186, 192, 197, fill='#d9deed', outline='')
        c.create_line(129, 79, 129, 66, fill='#4f66d7', width=5)
        c.create_oval(123, 57, 136, 70, fill='#97efd5', outline='#5c78d9')
        c.create_oval(84, 130, 174, 185, fill='#647af0', outline='#334dba', width=2)
        c.create_oval(78, 170, 109, 193, fill='#536de1', outline='#334dba', width=2)
        c.create_oval(149, 171, 180, 194, fill='#536de1', outline='#334dba', width=2)
        c.create_oval(69, 98, 94, 132, fill='#6782f4', outline='#334dba', width=2)
        c.create_oval(165, 98, 187, 132, fill='#6782f4', outline='#334dba', width=2)
        c.create_oval(80, 74, 178, 155, fill='#738afa', outline='#334dba', width=2)
        c.create_rectangle(94, 100, 165, 134, fill='#233775', outline='#253672', width=3)
        c.create_line(107, 109, 116, 117, 107, 124, fill='#9cf5d8', width=4)
        c.create_line(127, 124, 140, 124, fill='#9cf5d8', width=4)
        c.create_polygon(140, 146, 190, 141, 185, 174, 139, 177, fill='#223575', outline='#132550', width=2)
        c.create_line(159, 153, 166, 158, 158, 164, fill='#9cf5d8', width=3)
        c.create_line(132, 180, 189, 177, fill='#304882', width=5)
        c.create_oval(77, 147, 99, 171, fill='#7188f4', outline='#334dba', width=2)

    def press(self, event):
        self.drag_start = (event.x_root, event.y_root, self.root.winfo_x(), self.root.winfo_y())
        self.moved = False

    def drag(self, event):
        sx, sy, wx, wy = self.drag_start
        dx, dy = event.x_root - sx, event.y_root - sy
        if abs(dx) + abs(dy) > 5:
            self.moved = True
        x = max(0, min(self.root.winfo_screenwidth() - 230, wx + dx))
        y = max(0, min(self.root.winfo_screenheight() - 210, wy + dy))
        self.root.geometry(f'+{x}+{y}')

    def release(self, _event):
        if not self.moved:
            self.open_app()

    def copy_url(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.server.url)

    def hide(self):
        self.root.withdraw()

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

    def tick(self):
        state = self.server.assistant.state()
        status = ('等待你的核准' if state['approvals'] else '正在處理任務…' if state['busy'] else
                  '連線中／請查看工作台' if not state['ready'] else
                  '請先登入 Codex' if not state['account'] else '點我開始工作')
        self.canvas.itemconfigure(self.label, text='Mini · ' + status)
        self.root.after(1000, self.tick)

    def quit(self):
        self.server.assistant.bridge.close()
        self.server.shutdown()
        self.root.destroy()


if __name__ == '__main__':
    server = start()
    desktop = Desktop(server)
    desktop.open_app()
    desktop.root.mainloop()
