from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1600, 1220
BG = (247, 244, 238)
INK = (43, 42, 39)
GRAY = (138, 133, 124)
BLUE = (77, 107, 254)
GREEN = (76, 154, 106)
AMBER = (217, 154, 78)
RED = (194, 91, 78)
PAPER = (255, 253, 248)
LINE = (226, 221, 210)

FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_B = r"C:\Windows\Fonts\msyhbd.ttc"
def f(size, bold=False):
    path = FONT_B if bold and os.path.exists(FONT_B) else FONT
    return ImageFont.truetype(path, size)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

def text(x, y, s, size=20, color=INK, bold=False, anchor="la"):
    d.text((x, y), s, font=f(size, bold), fill=color, anchor=anchor)

def box(x1, y1, x2, y2, fill=PAPER, outline=LINE, r=16, width=2):
    d.rounded_rectangle([x1, y1, x2, y2], radius=r, fill=fill, outline=outline, width=width)

def arrow(x1, y1, x2, y2, color=GRAY, width=3):
    d.line([x1, y1, x2, y2], fill=color, width=width)
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    L = 12
    for s in (-0.5, 0.5):
        d.line([x2, y2, x2 - L * math.cos(ang + s), y2 - L * math.sin(ang + s)], fill=color, width=width)

# 标题
text(48, 40, "小满 · 情感与记忆架构", 42, INK, True)
text(48, 96, "情感决定「大体怎么说」，记忆决定「记得什么」；两者在一轮对话里汇合", 20, GRAY)

# ============ 左：情感 ============
box(48, 140, 780, 950)
text(76, 164, "情感：四层状态 + 一个出口", 26, INK, True)

layers = [
    ("性格", "固定基线", "决定表达上限", BLUE),
    ("好感", "周 – 月", "对这个人，慢", GREEN),
    ("心情", "约 2 小时", "这一阵子的底色", AMBER),
    ("情绪", "约 30 秒", "这一句的起伏", RED),
]
y = 210
for name, span, desc, color in layers:
    box(76, y, 470, y + 96)
    d.rounded_rectangle([76, y, 86, y + 96], radius=4, fill=color)
    text(104, y + 14, name, 26, INK, True)
    text(104, y + 52, span, 18, GRAY)
    text(230, y + 40, desc, 19, color)
    y += 150

for i in range(3):
    arrow(273, 306 + i * 150, 273, 356 + i * 150, GRAY)
text(286, 320, "衰减并入", 15, GRAY)
text(286, 470, "衰减并入", 15, GRAY)
text(286, 620, "衰减并入", 15, GRAY)

# 出口
box(500, 210, 752, 620)
text(524, 232, "表达 / 出口", 24, INK, True)
lines = [
    ("register", "称呼 · 距离 · 主动", BLUE),
    ("texture", "句长 · emoji · 语气词", AMBER),
]
ly = 280
for k, v, c in lines:
    text(524, ly, k, 20, c, True)
    text(524, ly + 28, v, 18, GRAY)
    ly += 86
text(524, 452, "大体 = 性格 + 好感", 20, INK, True)
text(524, 486, "细节 = 心情 + 情绪", 20, INK, True)
text(524, 540, "情绪只给「变化量」", 17, GRAY)
text(524, 566, "数值由插件维护", 17, GRAY)

arrow(472, 450, 498, 450, BLUE)

# ============ 右：记忆 ============
box(800, 140, 1552, 950)
text(828, 164, "记忆：存 · 取 · 压", 26, INK, True)

# 第一行：写入
box(828, 210, 1010, 296)
text(848, 232, "对话", 24, INK, True)
text(848, 264, "用户说的一句话", 16, GRAY)

box(1050, 210, 1240, 296, fill=(240, 244, 255), outline=BLUE)
text(1068, 232, "pet_remember", 21, BLUE, True)
text(1068, 264, "每轮写一条", 16, GRAY)

box(1280, 210, 1524, 296)
text(1298, 232, "SQLite 记忆库", 21, INK, True)
text(1298, 264, "长期保存", 16, GRAY)

arrow(1012, 253, 1046, 253, BLUE)
arrow(1242, 253, 1276, 253, BLUE)

# 分类（两行，避免溢出）
chips = [["事件", "事实", "喜好"], ["关系", "交接", "梦"]]
for row, group in enumerate(chips):
    cx = 1298
    for c in group:
        w = 62
        y0 = 306 + row * 40
        box(cx, y0, cx + w, y0 + 30, fill=(247, 244, 238), outline=LINE, r=10)
        text(cx + w / 2, y0 + 15, c, 14, GRAY, anchor="mm")
        cx += w + 6

# 第二行：召回
box(1050, 396, 1240, 482, fill=(240, 250, 242), outline=GREEN)
text(1070, 418, "pet_recall", 21, GREEN, True)
text(1070, 450, "回答前先看一眼", 16, GRAY)
box(828, 396, 1010, 482)
text(848, 418, "注入 prompt", 21, INK, True)
text(848, 450, "别硬编", 16, GRAY)
arrow(1046, 439, 1012, 439, GREEN)
arrow(1400, 396, 1150, 394, GREEN)
text(1250, 366, "按话题取", 15, GREEN)

# 检索
box(828, 500, 1524, 590, fill=(252, 250, 244))
text(848, 516, "检索：图 + 关键词 + 向量 → RRF 融合", 20, INK, True)
text(848, 552, "实体 1–2 跳扩展 · BM25 · 余弦相似度 · 时间/情绪/人物偏置", 17, GRAY)

# 两种压缩
box(828, 640, 1170, 890)
text(850, 662, "① 强制压缩", 23, RED, True)
text(850, 700, "上下文 ≥ 256K", 19, INK)
text(850, 730, "→ 写 kind:handoff", 19, GRAY)
text(850, 760, "→ 会话纪元 +1", 19, GRAY)
text(850, 790, "→ 下条消息开新会话", 19, GRAY)
text(850, 828, "旧事全在库里，换窗不换人", 16, RED)

box(1200, 640, 1524, 890)
text(1222, 662, "② 空闲做梦", 23, BLUE, True)
text(1222, 700, "45 分钟没动静", 19, INK)
text(1222, 730, "→ 同话题 ≥3 条合并", 19, GRAY)
text(1222, 760, "→ 写 kind:dream", 19, GRAY)
text(1222, 790, "→ 顺手做衰减", 19, GRAY)
text(1222, 828, "不换会话，越聊越像人", 16, BLUE)

arrow(1120, 592, 1000, 636, RED)
arrow(1400, 592, 1380, 636, BLUE)

text(48, 962, "核心：模型给「发生了什么」，插件算「你什么状态、记得什么」——数值不可自报篡改。", 17, GRAY)

# ============ 底部：衰减曲线 + 触发规则 ============
import math

box(48, 1000, 900, 1180)
text(76, 1018, "衰减曲线：偏离量还剩多少（0–6 小时）", 22, INK, True)

# 坐标区
x0, x1, y0, y1 = 120, 590, 1150, 1060
d.line([x0, y0, x1, y0], fill=LINE, width=2)
d.line([x0, y0, x0, y1], fill=LINE, width=2)
for h in (0, 2, 4, 6):
    x = x0 + (x1 - x0) * h / 6
    d.line([x, y0, x, y0 + 4], fill=LINE, width=1)
    text(x, y0 + 8, f"{h}h", 12, GRAY, anchor="ma")

text(x0 - 8, y1, "1.0", 12, GRAY, anchor="ra")
text(x0 - 8, (y0 + y1) / 2, "0.5", 12, GRAY, anchor="rm")
text(x0 - 8, y0, "0", 12, GRAY, anchor="rm")

curves = [
    ("情绪 30s", 30 / 3600, RED),
    ("心情 2h", 2, AMBER),
    ("精力 3h", 3, GREEN),
]
for name, tau, color in curves:
    pts = []
    for i in range(61):
        h = 6 * i / 60
        v = math.exp(-h / tau) if tau > 0.001 else 0
        pts.append((x0 + (x1 - x0) * h / 6, y0 - (y0 - y1) * v))
    d.line(pts, fill=color, width=3, joint="curve")

# 图例（右侧竖排，避免和曲线尾巴打架）
for i, (name, tau, color) in enumerate(curves):
    ly = 1072 + i * 34
    d.line([632, ly, 662, ly], fill=color, width=3)
    text(672, ly - 9, name, 14, color)

box(920, 1000, 1552, 1180)
text(948, 1018, "触发规则（8 类，±0.5~1.5）", 22, INK, True)
rules = [
    ("夸 / 想你", "mood +1 · 好感 +0.5"),
    ("骂 / 讨厌", "mood −1.5 · 好感 −0.5"),
    ("累 / 加班", "mood −1 · 精力 −1"),
    ("晚安 / 睡了", "精力 −0.5"),
    ("道歉 / 我错了", "mood +0.5 · 好感 +0.5"),
    ("撒娇 / 陪我", "mood +0.5 · 好感 +0.5"),
    ("好消息 / 升职", "mood +1"),
    ("好久不见", "mood +1 · 好感 +0.5"),
]
for i, (k, v) in enumerate(rules):
    col, row = i % 2, i // 2
    x = 948 + col * 310
    y = 1054 + row * 30
    text(x, y, k, 15, INK, True)
    text(x + 120, y, v, 14, GRAY)

text(48, 1200, "规则先跑（兜底）→ 模型 state 覆盖（上限 ±6）→ 时间衰减回落；所有值钳在 0–100。", 16, GRAY)

# 左侧补充说明
text(76, 790, "四层状态都落 SQLite，重启不丢", 18, GRAY)
text(76, 818, "时间尺度：秒 → 小时 → 周 → 固定", 17, GRAY)
text(76, 856, "触发规则 8 类：夸 / 骂 / 累 / 晚安… → ±0.5~1.5", 17, GRAY)
text(76, 884, "规则先跑，模型 state 再覆盖；单轮封顶", 17, GRAY)

img.save(os.path.join(os.path.dirname(__file__), "architecture.png"))
print("saved")
