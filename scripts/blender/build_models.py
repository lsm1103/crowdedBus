"""
好挤的大巴 —— 程序化建模脚本（Blender 5.x）。

用法（通常走 npm run model:build）：
  Blender -b --factory-startup -P scripts/blender/build_models.py -- \
      assets-src/layout.json public/models assets-src/crowded_bus.blend

产出：
  public/models/bus.glb   车身、车门、车轮、座位、扶手、车内物件
  public/models/city.glb  始发站站台、中途站牌、楼房、树、路灯、灌木
  assets-src/crowded_bus.blend  可在 Blender 里打开查看/微调（重跑脚本会覆盖）

约定：
- 脚本里所有坐标都按 **three.js 坐标系** 书写（y 朝上、车头朝 +z、车门在 +x 一侧），
  最后统一乘一次 T 换到 Blender（z 朝上）。glTF 导出器再把它换回 y 朝上，
  所以游戏里读到的坐标和这里写的数字完全一致，没有任何心算换轴。
- 所有和玩法对齐的位置（门洞、座位、扶手、障碍物、站台围栏）一律读 layout.json，
  不在这里写死 —— 车模和碰撞对不上正是旧版穿模的根源。
- 需要被代码驱动的部件（车门扇、车轮、扶手、线路牌、站牌）是独立节点，
  名字就是接口，见 src/view/bus.ts 和 src/view/scenery.ts。
"""
import bpy, bmesh, json, math, os, sys
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
LAYOUT_PATH, OUT_DIR, BLEND_PATH = argv[0], argv[1], argv[2]
L = json.load(open(LAYOUT_PATH, encoding='utf-8'))

bpy.ops.wm.read_factory_settings(use_empty=True)

# three.js (x, y, z) -> Blender (x, -z, y)。行列式为 1，是纯旋转，不会把法线翻过去。
T = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))

# ---------------------------------------------------------------- 尺寸常量
GROUND_Y = -1.0          # 路面
X_OUT = 2.65             # 车身外皮（= 碰撞墙外沿）
X_IN = 2.40              # 车壁内侧（碰撞墙内沿是 2.35，留 5cm 给角色手臂）
Z_TAIL = -6.95           # 车尾外沿
Z_TAIL_IN = -6.40        # 车尾内壁（= 碰撞墙内沿）
Z_CAB = 6.40             # 驾驶室隔断（= 碰撞墙内沿，乘客区到此为止）
Z_SHIELD = 7.45          # 前挡风起点
Z_FRONT = 7.75           # 车头外沿
Y_SKIRT = -0.72
Y_BELT0, Y_BELT1, Y_SILL = 0.62, 0.72, 0.80
Y_WIN, Y_TOP, Y_RIM = 1.72, 2.02, 2.08
Y_BAR = 2.24             # 顶部横杆（吊环下沿 1.92，高过角色头顶 + 走路起伏）
WHEEL_R = 0.46
AXLE_Y = GROUND_Y + WHEEL_R
ARCH_R = 0.53
# 车轮放在四角：后轮避开后门、前轮避开前门，轮顶低于地板，车厢里不会再冒出轮胎。
AXLES = {'front': 6.0, 'rear': -5.95}

# ---------------------------------------------------------------- 材质
def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    return (lin[0], lin[1], lin[2], 1.0)

PALETTE = {
    # 车身：对齐概念图的"红色公交 + 蓝绿座椅 + 明黄扶手"
    'body_red': '#E4463C', 'body_white': '#F7F4EE', 'trim_dark': '#39414D',
    'frame_dark': '#46505E', 'glass': '#BFE8F4', 'lining_cream': '#F3EDE2',
    'rim_grey': '#D9DEE5', 'hazard_yellow': '#FFC933', 'rail_yellow': '#FFD23F',
    'grip_warm': '#FF9F1C', 'grip_teal': '#2EC4B6', 'grip_white': '#F4F1E8',
    'seat_teal': '#26A69A', 'seat_pink': '#EF7C95', 'seat_base': '#5B6676',
    'tire': '#2A2E35', 'hub': '#C9D2DC', 'emit_head': '#FFF6D8', 'emit_tail': '#FF4A3D',
    'emit_green': '#6BE59A', 'floor': '#9EAAB8', 'step_dark': '#4A5360',
    'door_frame': '#E9EDF2', 'sign_black': '#141A24', 'luggage_a': '#C0563B',
    'luggage_b': '#3E7CC9', 'cardboard': '#C99A62', 'tape': '#E8D5AA',
    'stroller_pink': '#F08CA4', 'stroller_hood': '#D65C7C', 'farebox': '#8FA7BF',
    'driver_uniform': '#2F4F7F', 'skin': '#F2C9A0', 'dash': '#3F4854', 'driver_seat': '#34506F',
    # 城市
    'station_top': '#E6DAC7', 'station_base': '#BCAF9B', 'rail_teal': '#2A8C82',
    'rail_white': '#F1F3F5', 'shelter_teal': '#2FA89A', 'wood': '#D9A066',
    'sign_teal': '#1F7A70', 'poster': '#FFF1D6', 'bld_window': '#3D5A80',
    'bld_trim': '#F4F1EA', 'bld_shop': '#6A93B8', 'bld_base': '#8C8C94',
    'awning_coral': '#FF7A6B', 'awning_yellow': '#FFC933', 'awning_teal': '#2EC4B6',
    'bld_peach': '#F6C9A3', 'bld_mint': '#A9DCC9', 'bld_lilac': '#CDBDEB', 'bld_sky': '#A7C8EE',
    'trunk': '#8A5A3C', 'leaf_a': '#5FAE4E', 'leaf_b': '#86C95F', 'lamp_pole': '#3F6F6A',
    'emit_lamp': '#FFF4D6', 'planter': '#D8CBB6', 'tank': '#B8C2CC',
}
_MATS = {}

def mat(name):
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.new(name)
    col = srgb(PALETTE[name])
    m.diffuse_color = col
    if m.node_tree is None:
        m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = col
    bsdf.inputs['Roughness'].default_value = 0.65
    if name == 'glass':
        bsdf.inputs['Alpha'].default_value = 0.3
        m.surface_render_method = 'BLENDED'
    if name.startswith('emit_'):
        bsdf.inputs['Emission Color'].default_value = col
        bsdf.inputs['Emission Strength'].default_value = 1.0
    _MATS[name] = m
    return m

# ---------------------------------------------------------------- 几何构建器
def align_z(d):
    """把 +Z 转到方向 d 的旋转矩阵（4x4）。"""
    return Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()

class Part:
    """一个导出节点。几何按 three.js 坐标写进同一个 bmesh，最后一次性换轴。"""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.mats = []

    def _mi(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def _paint(self, verts, m, bevel=0.0, segs=2, edge_filter=None):
        faces = {f for v in verts for f in v.link_faces}
        mi = self._mi(m)
        for f in faces:
            f.material_index = mi
        if bevel > 0:
            edges = [e for e in {e for v in verts for e in v.link_edges}
                     if edge_filter is None or edge_filter(e)]
            if edges:
                bmesh.ops.bevel(self.bm, geom=edges, offset=bevel, segments=segs,
                                affect='EDGES', clamp_overlap=True, profile=0.5)
        return verts

    def box(self, x0, x1, y0, y1, z0, z1, m, bevel=0.0, segs=2, rot_y=0.0, rot_x=0.0, edge_filter=None):
        c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
        S = Matrix.Diagonal((abs(x1 - x0), abs(y1 - y0), abs(z1 - z0), 1.0))
        R = Matrix.Rotation(rot_y, 4, 'Y') @ Matrix.Rotation(rot_x, 4, 'X')
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=Matrix.Translation(c) @ R @ S, calc_uvs=True)
        return self._paint(r['verts'], m, bevel, segs, edge_filter)

    def cyl(self, p0, p1, r, m, segs=16, bevel=0.0, r2=None):
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        M = Matrix.Translation((p0 + p1) / 2) @ align_z(d)
        res = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                    radius1=r, radius2=r if r2 is None else r2, depth=d.length, matrix=M)
        return self._paint(res['verts'], m, bevel, 2)

    def sphere(self, c, r, m, subdiv=2, scale=(1, 1, 1)):
        M = Matrix.Translation(c) @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=subdiv, radius=r, matrix=M)
        return self._paint(res['verts'], m)

    def torus(self, c, major, minor, m, normal=(0, 0, 1), seg=20, mseg=8):
        """圆环，normal 是圆环所在平面的法线。"""
        M = Matrix.Translation(c) @ align_z(Vector(normal))
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            row = []
            for j in range(mseg):
                b = 2 * math.pi * j / mseg
                rr = major + minor * math.cos(b)
                p = Vector((rr * math.cos(a), rr * math.sin(a), minor * math.sin(b)))
                row.append(self.bm.verts.new(M @ p))
            ring.append(row)
        for i in range(seg):
            for j in range(mseg):
                a, b = ring[i][j], ring[(i + 1) % seg][j]
                c2, d = ring[(i + 1) % seg][(j + 1) % mseg], ring[i][(j + 1) % mseg]
                self.bm.faces.new((a, b, c2, d))
        return self._paint([v for row in ring for v in row], m)

    def quad(self, p0, p1, p2, p3, m):
        """带 0~1 UV 的四边形，逆时针（从法线正方向看）：左下、右下、右上、左上。"""
        vs = [self.bm.verts.new(Vector(p)) for p in (p0, p1, p2, p3)]
        f = self.bm.faces.new(vs)
        for loop, uv in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            loop[self.uv].uv = uv
        f.material_index = self._mi(m)
        return vs

    def verts_poly(self, pts, m):
        vs = [self.bm.verts.new(Vector(p)) for p in pts]
        f = self.bm.faces.new(vs)
        f.material_index = self._mi(m)
        return vs

    def finalize(self, coll, origin=(0, 0, 0), smooth=True):
        o = Vector(origin)
        bmesh.ops.translate(self.bm, vec=-o, verts=self.bm.verts)
        bmesh.ops.transform(self.bm, matrix=T, verts=self.bm.verts)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        # 纯色件全部烘成顶点色、共用一个材质 —— 一个节点只剩 1 次 draw call；
        # 只有玻璃（半透明）和发光件（不受光）必须单独成材质。
        special = [n for n in self.mats if is_special(n)]
        slots = (['vc'] if len(special) < len(self.mats) else []) + special
        col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        for poly in me.polygons:
            n = self.mats[poly.material_index]
            c = srgb(PALETTE[n])
            poly.material_index = slots.index(n if is_special(n) else 'vc')
            for li in poly.loop_indices:
                col.data[li].color = c
        for n in slots:
            me.materials.append(vc_mat() if n == 'vc' else mat(n))
        if smooth:
            me.shade_smooth()
            me.set_sharp_from_angle(angle=math.radians(38))
        else:
            me.shade_flat()
        ob = bpy.data.objects.new(self.name, me)
        ob.location = (T @ o.to_4d()).to_3d()
        coll.objects.link(ob)
        return ob

def is_special(n):
    return n == 'glass' or n.startswith('emit_')

_VC = []

def vc_mat():
    if _VC:
        return _VC[0]
    m = bpy.data.materials.new('vc')
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    node = nt.nodes.new('ShaderNodeVertexColor')
    node.layer_name = 'Col'
    nt.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.65
    _VC.append(m)
    return m

def new_coll(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c

# ================================================================= 车身
BUS = new_coll('BUS')
doors = {d['id']: d for d in L['doors']}
I = L['interior']

def side_x(s, x):
    """s=+1 近侧（车门一侧）、-1 远侧；x 为到中线的距离。"""
    return s * x

def xr(s, a, b):
    """把一侧的 [a,b]（距离）换成有序的世界 x 区间。"""
    lo, hi = sorted((s * a, s * b))
    return lo, hi

def build_chassis():
    p = Part('bus_chassis')
    # 只倒底边和四个竖角：顶边要和车壁严丝合缝。
    def ef(e):
        a, b = e.verts[0].co, e.verts[1].co
        bottom = abs(a.y - Y_SKIRT) < 1e-4 and abs(b.y - Y_SKIRT) < 1e-4
        vertical = abs(a.x - b.x) < 1e-4 and abs(a.z - b.z) < 1e-4
        return bottom or vertical
    p.box(-X_OUT, X_OUT, Y_SKIRT, 0.0, Z_TAIL, Z_FRONT, 'body_red', bevel=0.12, segs=3, edge_filter=ef)
    ob = p.finalize(BUS)
    # 轮拱：布尔挖掉，切口面转移成切割体的深灰材质，看起来就是轮拱内衬。
    for z in AXLES.values():
        cp = Part('cut')
        cp.cyl((-X_OUT - 0.3, AXLE_Y, z), (-X_OUT + 0.42, AXLE_Y, z), ARCH_R, 'trim_dark', segs=32)
        cp.cyl((X_OUT - 0.42, AXLE_Y, z), (X_OUT + 0.3, AXLE_Y, z), ARCH_R, 'trim_dark', segs=32)
        cut = cp.finalize(BUS, smooth=False)
        mod = ob.modifiers.new('arch', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.object = cut
        mod.solver = 'EXACT'
        mod.material_mode = 'TRANSFER'
        dg = bpy.context.evaluated_depsgraph_get()
        nm = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
        ob.modifiers.clear()
        old = ob.data
        ob.data = nm
        bpy.data.meshes.remove(old)
        bpy.data.objects.remove(cut)
    ob.data.name = 'bus_chassis'
    me = ob.data
    # 切割体的面转移过来时带的是切割体自己的顶点色（深灰），正好是轮拱内衬色；
    # 这里只需把所有面并回同一个顶点色材质槽。
    vc_i = next(i for i, m in enumerate(me.materials) if m and m.name == 'vc')
    for poly in me.polygons:
        poly.material_index = vc_i
    while len(me.materials) > 1:
        me.materials.pop(index=len(me.materials) - 1 if len(me.materials) - 1 != vc_i else 0)
    me.set_sharp_from_angle(angle=math.radians(38))
    return ob

def wall_band(p, s, z0, z1, lower=True, upper=True):
    """一段车壁（不含立柱和玻璃）。lower = 腰线及以下，upper = 窗上沿及顶边。"""
    if lower:
        p.box(*xr(s, X_IN, X_OUT), 0.0, Y_BELT0, z0, z1, 'body_red', bevel=0.015)
        p.box(*xr(s, X_IN - 0.02, X_IN), 0.02, Y_BELT0, z0, z1, 'lining_cream')
        p.box(*xr(s, X_IN, X_OUT + 0.02), Y_BELT0, Y_BELT1, z0, z1, 'body_white', bevel=0.012)
        p.box(*xr(s, X_IN - 0.02, X_OUT + 0.01), Y_BELT1, Y_SILL, z0, z1, 'frame_dark', bevel=0.012)
    if upper:
        p.box(*xr(s, X_IN, X_OUT), Y_WIN, Y_TOP, z0, z1, 'body_red', bevel=0.015)
        p.box(*xr(s, X_IN - 0.02, X_IN), Y_WIN, Y_TOP, z0, z1, 'lining_cream')

def windows(p, s, spans):
    """spans: [(z0, z1)] 玻璃区间；立柱由调用方给。"""
    for z0, z1 in spans:
        p.box(*xr(s, 2.50, 2.54), Y_SILL, Y_WIN, z0, z1, 'glass')

def pillars(p, s, zs, w=0.14):
    for z in zs:
        p.box(*xr(s, X_IN, X_OUT - 0.01), Y_SILL, Y_WIN, z - w / 2, z + w / 2, 'frame_dark', bevel=0.012)

def spans_between(z0, z1, cuts, w=0.14):
    """z0..z1 之间按立柱中心 cuts 切出玻璃区间。"""
    edges = [z0] + [c for z in cuts for c in (z - w / 2, z + w / 2)] + [z1]
    return [(edges[i], edges[i + 1]) for i in range(0, len(edges), 2) if edges[i + 1] - edges[i] > 0.02]

def build_sides():
    lower = Part('bus_lower')      # 腰线以下：永远不淡出（高 0.8，越肩机位的视线挡不到人身上）
    near_up = Part('bus_near_upper')
    far_up = Part('bus_far_upper')
    dB, dF = doors['back'], doors['front']
    JW = 0.10  # 门框宽度

    # ---- 远侧（驾驶员一侧）：整面带窗
    s = -1
    wall_band(lower, s, Z_TAIL_IN, Z_SHIELD, lower=True, upper=False)
    wall_band(far_up, s, Z_TAIL_IN, Z_SHIELD, lower=False, upper=True)
    n = 8
    far_p = [Z_TAIL_IN + 0.07 + k * ((Z_CAB - 0.07) - (Z_TAIL_IN + 0.07)) / n for k in range(n + 1)]
    far_p.append(Z_SHIELD - 0.07)
    pillars(far_up, s, far_p)
    windows(far_up, s, spans_between(Z_TAIL_IN, Z_SHIELD, far_p))
    far_up.box(*xr(s, X_IN - 0.03, X_OUT + 0.02), Y_TOP, Y_RIM, Z_TAIL_IN, Z_CAB, 'rim_grey', bevel=0.01)

    # ---- 近侧（车门一侧）：三段墙 + 两个门洞
    s = +1
    segs = [(Z_TAIL_IN, dB['zMin'] - JW), (dB['zMax'] + JW, dF['zMin'] - JW), (dF['zMax'] + JW, Z_SHIELD)]
    for z0, z1 in segs:
        wall_band(lower, s, z0, z1, lower=True, upper=False)
        wall_band(near_up, s, z0, z1, lower=False, upper=True)
    near_p_rear = [Z_TAIL_IN + 0.07]
    mid0, mid1 = segs[1]
    near_p_mid = [mid0 + (mid1 - mid0) * k / 4 for k in (1, 2, 3)]
    near_p_front = [Z_CAB - 0.07, Z_SHIELD - 0.07]
    pillars(near_up, s, near_p_rear + near_p_mid + near_p_front)
    windows(near_up, s, spans_between(segs[0][0], segs[0][1], near_p_rear)
            + spans_between(mid0, mid1, near_p_mid)
            + spans_between(segs[2][0], segs[2][1], near_p_front))
    near_up.box(*xr(s, X_IN - 0.03, X_OUT + 0.02), Y_TOP, Y_RIM, Z_TAIL_IN, Z_CAB, 'rim_grey', bevel=0.01)

    for d in (dB, dF):
        # 门框：黄色全高，是"这里会掉下去"的第一视觉语言，所以放在永不淡出的 lower 里。
        for z0, z1 in ((d['zMin'] - JW, d['zMin']), (d['zMax'], d['zMax'] + JW)):
            lower.box(X_IN - 0.02, X_OUT + 0.02, 0.0, Y_TOP, z0, z1, 'hazard_yellow', bevel=0.015)
        # 门楣
        near_up.box(X_IN, X_OUT, 1.90, Y_TOP, d['zMin'], d['zMax'], 'body_red', bevel=0.012)
        # 门槛踏板：深灰 + 外沿一道黄线
        lower.box(X_IN, X_OUT - 0.06, -0.02, 0.02, d['zMin'], d['zMax'], 'step_dark')
        lower.box(X_OUT - 0.06, X_OUT + 0.01, -0.02, 0.028, d['zMin'], d['zMax'], 'hazard_yellow')
    return lower, near_up, far_up

def vcorner(zc):
    """只选车身外角（|x|≈外皮、z≈zc）的竖直棱：车头车尾上下几块要倒同样的大圆角才接得上。"""
    def f(e):
        a, b = e.verts[0].co, e.verts[1].co
        vertical = abs(a.x - b.x) < 1e-4 and abs(a.z - b.z) < 1e-4
        return vertical and abs(abs(a.x) - X_OUT) < 0.03 and abs(a.z - zc) < 0.03
    return f

def build_tail(lower):
    up = Part('bus_tail_upper')
    lower.box(-X_OUT, X_OUT, 0.0, Y_BELT0, Z_TAIL, Z_TAIL_IN, 'body_red', bevel=0.12, segs=3,
              edge_filter=vcorner(Z_TAIL))
    lower.box(-X_OUT - 0.02, X_OUT + 0.02, Y_BELT0, Y_BELT1, Z_TAIL - 0.02, Z_TAIL_IN, 'body_white', bevel=0.012)
    lower.box(-X_OUT, X_OUT, Y_BELT1, 0.95, Z_TAIL, Z_TAIL_IN, 'body_red', bevel=0.12, segs=3, edge_filter=vcorner(Z_TAIL))
    lower.box(-X_IN + 0.02, X_IN - 0.02, 0.02, 0.95, Z_TAIL_IN, Z_TAIL_IN + 0.02, 'lining_cream')
    # 尾灯、格栅、保险杠
    for sx in (-1, 1):
        lower.box(*sorted((sx * 1.95, sx * 2.45)), 0.14, 0.48, Z_TAIL - 0.04, Z_TAIL + 0.01, 'emit_tail', bevel=0.02)
    for y in (0.14, 0.28, 0.42):
        lower.box(-1.25, 1.25, y, y + 0.06, Z_TAIL - 0.03, Z_TAIL + 0.01, 'trim_dark')
    lower.box(-2.62, 2.62, Y_SKIRT, -0.34, Z_TAIL - 0.22, Z_TAIL + 0.1, 'trim_dark', bevel=0.07)
    # 后窗（上半，可淡出）
    for sx in (-1, 1):
        up.box(*sorted((sx * 1.95, sx * X_OUT)), 0.95, Y_WIN, Z_TAIL, Z_TAIL_IN, 'body_red', bevel=0.12, segs=3, edge_filter=vcorner(Z_TAIL))
    up.box(-1.95, 1.95, 0.95, Y_WIN, Z_TAIL + 0.03, Z_TAIL + 0.07, 'glass')
    up.box(-X_OUT, X_OUT, Y_WIN, Y_TOP, Z_TAIL, Z_TAIL_IN, 'body_red', bevel=0.12, segs=3, edge_filter=vcorner(Z_TAIL))
    up.box(-X_IN + 0.02, X_IN - 0.02, Y_WIN, Y_TOP, Z_TAIL_IN, Z_TAIL_IN + 0.02, 'lining_cream')
    up.box(-X_OUT - 0.02, X_OUT + 0.02, Y_TOP, Y_RIM, Z_TAIL - 0.02, Z_TAIL_IN, 'rim_grey', bevel=0.01)
    up.box(-0.5, 0.5, 1.76, 1.99, Z_TAIL - 0.05, Z_TAIL + 0.01, 'sign_black', bevel=0.01)
    return up

def build_nose(lower, interior):
    up = Part('bus_nose_upper')
    zf = Z_FRONT
    # 车头面（腰线以下永远可见）
    lower.box(-X_OUT, X_OUT, 0.0, Y_BELT0, Z_SHIELD, zf, 'body_red', bevel=0.12, segs=3,
              edge_filter=vcorner(zf))
    lower.box(-X_OUT - 0.02, X_OUT + 0.02, Y_BELT0, Y_BELT1, Z_SHIELD, zf + 0.02, 'body_white', bevel=0.012)
    lower.box(-X_OUT, X_OUT, Y_BELT1, 1.02, Z_SHIELD, zf, 'body_red', bevel=0.12, segs=3, edge_filter=vcorner(zf))
    for sx in (-1, 1):
        a, b = sorted((sx * 1.56, sx * 2.36))
        lower.box(a, b, 0.07, 0.45, zf - 0.02, zf + 0.02, 'trim_dark', bevel=0.02)
        a, b = sorted((sx * 1.62, sx * 2.30))
        lower.box(a, b, 0.12, 0.40, zf, zf + 0.05, 'emit_head', bevel=0.03)
    for y in (-0.24, -0.14, -0.04):
        lower.box(-1.1, 1.1, y, y + 0.05, zf - 0.02, zf + 0.02, 'trim_dark')
    lower.box(-2.62, 2.62, Y_SKIRT, -0.34, zf - 0.08, zf + 0.23, 'trim_dark', bevel=0.07)
    lower.box(-0.45, 0.45, -0.62, -0.42, zf + 0.22, zf + 0.25, 'body_white', bevel=0.01)
    # 前挡风 + A 柱 + 顶盖 + 线路牌（上半，可淡出）
    for sx in (-1, 1):
        up.box(*sorted((sx * 2.42, sx * X_OUT)), 1.02, 1.90, Z_SHIELD, zf, 'frame_dark', bevel=0.12, segs=3, edge_filter=vcorner(zf))
    up.box(-2.42, 2.42, 1.02, 1.08, Z_SHIELD + 0.1, zf, 'frame_dark')
    up.box(-2.42, 2.42, 1.08, 1.90, Z_SHIELD + 0.16, Z_SHIELD + 0.2, 'glass', rot_x=math.radians(-6))
    up.box(-X_OUT, X_OUT, 1.90, Y_TOP, Z_SHIELD, zf, 'body_red', bevel=0.12, segs=3, edge_filter=vcorner(zf))
    up.box(-X_OUT - 0.02, X_OUT + 0.02, Y_TOP, 2.14, Z_CAB, zf + 0.02, 'body_red', bevel=0.04)
    up.box(-1.2, 1.2, 1.93, 2.24, zf - 0.14, zf + 0.03, 'sign_black', bevel=0.015)
    # 后视镜
    for sx in (-1, 1):
        up.cyl((sx * 2.62, 1.62, zf - 0.12), (sx * 2.96, 1.66, zf - 0.02), 0.03, 'trim_dark', segs=8)
        a, b = sorted((sx * 2.92, sx * 3.04))
        up.box(a, b, 1.30, 1.78, zf - 0.08, zf + 0.02, 'trim_dark', bevel=0.03)
    # 驾驶室：隔断 + 仪表台 + 司机。全部在碰撞墙之前，乘客走不进来。
    interior.box(-X_IN + 0.02, X_IN - 0.02, 0.0, 0.95, Z_CAB, Z_CAB + 0.08, 'lining_cream', bevel=0.01)
    interior.box(-X_IN + 0.02, X_IN - 0.02, 0.95, 1.0, Z_CAB - 0.01, Z_CAB + 0.09, 'rail_yellow', bevel=0.015)
    interior.box(-X_IN + 0.02, X_IN - 0.02, -0.01, 0.016, Z_CAB + 0.08, Z_SHIELD, 'step_dark')
    interior.box(-X_IN + 0.02, X_IN - 0.02, 0.0, 1.0, 7.2, Z_SHIELD, 'dash', bevel=0.03)
    dx = -1.30
    interior.box(dx - 0.32, dx + 0.32, 0.0, 0.40, 6.62, 7.02, 'trim_dark', bevel=0.02)
    interior.box(dx - 0.34, dx + 0.34, 0.40, 0.52, 6.58, 7.04, 'driver_seat', bevel=0.04)
    interior.box(dx - 0.34, dx + 0.34, 0.52, 1.30, 6.48, 6.62, 'driver_seat', bevel=0.04)
    interior.cyl((dx, 0.95, 7.28), (dx, 1.12, 7.12), 0.035, 'trim_dark', segs=8)
    interior.torus((dx, 1.17, 7.10), 0.22, 0.035, 'trim_dark', normal=(0, math.sin(math.radians(55)), -math.cos(math.radians(55))), seg=24, mseg=6)
    # 司机：极简的道具人，不是可玩角色。
    interior.box(dx - 0.25, dx + 0.25, 0.52, 1.10, 6.66, 7.0, 'driver_uniform', bevel=0.12, segs=3)
    interior.sphere((dx, 1.36, 6.84), 0.24, 'skin')
    interior.cyl((dx, 1.46, 6.84), (dx, 1.58, 6.84), 0.25, 'driver_uniform', segs=16, bevel=0.02)
    interior.box(dx - 0.2, dx + 0.2, 1.46, 1.50, 7.02, 7.16, 'driver_uniform')
    for sx in (-1, 1):
        interior.cyl((dx + sx * 0.24, 1.02, 6.86), (dx + sx * 0.17, 1.14, 7.06), 0.06, 'driver_uniform', segs=8)
    return up

def build_interior(interior):
    # 地板面：单独节点，代码给它贴防滑纹理。
    fl = Part('floor_surface')
    # 点序决定法线：(+x) × (-z) = +y，法线朝上。u 沿 +x，v 沿 -z。
    fl.quad((-X_IN, 0.014, Z_CAB), (X_IN, 0.014, Z_CAB), (X_IN, 0.014, Z_TAIL_IN), (-X_IN, 0.014, Z_TAIL_IN), 'floor')
    # 座位
    for s in L['seats']:
        z = s['z']
        c = 'seat_pink' if s['kind'] == 'priority' else 'seat_teal'
        interior.box(-2.30, -1.62, 0.0, 0.30, z - 0.42, z + 0.42, 'seat_base', bevel=0.03)
        interior.box(-2.32, -1.42, 0.30, 0.46, z - 0.49, z + 0.49, c, bevel=0.06, segs=3)
        interior.box(-2.36, -2.14, 0.44, 1.28, z - 0.49, z + 0.49, c, bevel=0.06, segs=3)
        interior.cyl((-2.25, 1.34, z - 0.4), (-2.25, 1.34, z + 0.4), 0.03, 'rail_yellow', segs=8)
    # 顶部横杆 + 吊环（黄），立杆单独成节点（要高亮）
    rails = L['handrails']
    zs = sorted(h['z'] for h in rails if abs(h['x']) < 1e-6)
    interior.cyl((0, Y_BAR, zs[0]), (0, Y_BAR, zs[-1]), 0.04, 'rail_yellow', segs=12)
    for z in (zs[0], zs[-1]):
        interior.sphere((0, Y_BAR, z), 0.055, 'rail_yellow', subdiv=2)
    for h in rails:
        if abs(h['x']) > 1e-6:
            interior.cyl((0, Y_BAR, h['z']), (h['x'], Y_BAR, h['z']), 0.035, 'rail_yellow', segs=10)
    loops = []
    for i in range(len(zs) - 1):
        a, b = zs[i], zs[i + 1]
        loops += [a + (b - a) / 3, a + 2 * (b - a) / 3]
    for zl in loops:
        interior.box(-0.018, 0.018, 2.07, Y_BAR, zl - 0.014, zl + 0.014, 'trim_dark')
        interior.torus((0, 2.005, zl), 0.07, 0.016, 'rail_yellow', normal=(1, 0, 0), seg=16, mseg=6)
    # 立杆和握把并进车内静态网格：原来 12 个独立节点就是 12 次 draw call，
    # 只为了"被抓住时换色"。高亮改由代码在被抓的那根上套一层发光外壳（见 src/view/bus.ts）。
    for h in rails:
        interior.cyl((h['x'], 0, h['z']), (h['x'], Y_BAR, h['z']), 0.045, 'rail_yellow', segs=12)
        interior.cyl((h['x'], 0, h['z']), (h['x'], 0.03, h['z']), 0.09, 'rail_yellow', segs=12)
        g = 'grip_warm' if h['z'] > 1.0 else 'grip_teal' if h['z'] < -1.0 else 'grip_white'
        interior.cyl((h['x'], 1.30, h['z']), (h['x'], 1.62, h['z']), 0.062, g, segs=12, bevel=0.015)
    # 障碍物：按碰撞矩形逐个摆
    for o in L['obstacles']:
        r = o['rect']
        x0, x1, z0, z1 = r['minX'], r['maxX'], r['minZ'], r['maxZ']
        cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        k = o['kind']
        if k == 'luggage':
            interior.box(x0 + 0.05, x1 - 0.05, 0.0, 0.48, z0 + 0.05, z1 - 0.05, 'luggage_a', bevel=0.07, segs=3)
            interior.box(x0 + 0.03, x1 - 0.03, 0.2, 0.26, z0 + 0.04, z1 - 0.04, 'trim_dark', bevel=0.02)
            interior.box(cx - 0.32, cx + 0.28, 0.48, 0.74, cz - 0.24, cz + 0.28, 'luggage_b', bevel=0.06, segs=3, rot_y=math.radians(14))
            interior.box(cx - 0.12, cx + 0.12, 0.74, 0.79, cz - 0.03, cz + 0.05, 'trim_dark', bevel=0.015, rot_y=math.radians(14))
        elif k == 'wheelwell':
            # 碰撞数据里叫"轮拱"，但真轮子在车四角 —— 视觉上改成一摞快递箱，挡路的读法不变。
            interior.box(x0 + 0.02, x1 - 0.02, 0.0, 0.30, z0 + 0.02, z1 - 0.02, 'cardboard', bevel=0.02)
            interior.box(cx - 0.05, cx + 0.05, 0.30, 0.305, z0 + 0.02, z1 - 0.02, 'tape')
            interior.box(cx - 0.2, cx + 0.2, 0.30, 0.52, cz - 0.2, cz + 0.36, 'cardboard', bevel=0.02, rot_y=math.radians(9))
            interior.box(cx - 0.045, cx + 0.045, 0.52, 0.525, cz - 0.2, cz + 0.36, 'tape', rot_y=math.radians(9))
        elif k == 'stroller':
            for sx in (x0 + 0.13, x1 - 0.13):
                for sz in (z0 + 0.16, z1 - 0.16):
                    interior.cyl((sx - 0.03, 0.11, sz), (sx + 0.03, 0.11, sz), 0.11, 'tire', segs=12)
            interior.box(x0 + 0.18, x1 - 0.18, 0.18, 0.26, z0 + 0.12, z1 - 0.12, 'trim_dark', bevel=0.02)
            interior.box(x0 + 0.08, x1 - 0.08, 0.28, 0.70, z0 + 0.1, z1 - 0.1, 'stroller_pink', bevel=0.12, segs=3)
            interior.box(x0 + 0.08, x1 - 0.08, 0.60, 0.95, cz + 0.02, z1 - 0.08, 'stroller_hood', bevel=0.15, segs=3)
            for sx in (x0 + 0.15, x1 - 0.15):
                interior.cyl((sx, 0.6, z0 + 0.14), (sx, 1.02, z0 + 0.02), 0.025, 'trim_dark', segs=8)
            interior.cyl((x0 + 0.13, 1.02, z0 + 0.02), (x1 - 0.13, 1.02, z0 + 0.02), 0.035, 'trim_dark', segs=8)
        elif k == 'bin':
            # 碰撞数据叫"垃圾桶"，紧挨前门 —— 画成投币箱，公交上真有、而且一眼认得。
            interior.cyl((cx, 0.0, cz), (cx, 0.03, cz), 0.2, 'trim_dark', segs=16)
            interior.cyl((cx, 0.0, cz), (cx, 0.54, cz), 0.09, 'trim_dark', segs=12)
            interior.box(x0 + 0.06, x1 - 0.06, 0.52, 0.86, z0 + 0.06, z1 - 0.06, 'farebox', bevel=0.04, segs=3)
            interior.box(x0 + 0.12, x1 - 0.12, 0.86, 0.88, z0 + 0.12, z1 - 0.12, 'hazard_yellow', bevel=0.01)
            interior.box(x1 - 0.08, x1 - 0.05, 0.62, 0.80, cz - 0.12, cz + 0.12, 'trim_dark', bevel=0.01)
            interior.box(x1 - 0.06, x1 - 0.045, 0.74, 0.77, cz - 0.04, cz + 0.04, 'emit_green')
    return fl

def build_wheels():
    out = []
    for key, z in AXLES.items():
        p = Part(f'axle_{key}')
        for sx in (-1, 1):
            a, b = sx * (X_OUT - 0.34), sx * (X_OUT - 0.04)
            p.cyl((a, AXLE_Y, z), (b, AXLE_Y, z), WHEEL_R, 'tire', segs=28, bevel=0.07)
            hx = sx * (X_OUT - 0.02)
            p.cyl((sx * (X_OUT - 0.10), AXLE_Y, z), (hx, AXLE_Y, z), 0.25, 'hub', segs=20, bevel=0.03)
            p.cyl((hx, AXLE_Y, z), (hx + sx * 0.02, AXLE_Y, z), 0.09, 'trim_dark', segs=12)
            # 轮毂上的 5 个螺栓，转起来才看得出在转。
            for k in range(5):
                a2 = 2 * math.pi * k / 5
                c = (hx + sx * 0.01, AXLE_Y + 0.16 * math.sin(a2), z + 0.16 * math.cos(a2))
                p.sphere(c, 0.03, 'trim_dark', subdiv=1)
        out.append((p, (0, AXLE_Y, z)))
    return out

def build_doors():
    out = []
    for d in L['doors']:
        zm = (d['zMin'] + d['zMax']) / 2
        for leaf, hinge, far in (('a', d['zMin'] + 0.02, zm - 0.01), ('b', d['zMax'] - 0.02, zm + 0.01)):
            p = Part(f"door_{d['id']}_{leaf}")
            z0, z1 = sorted((hinge, far))
            x0, x1 = 2.55, 2.61
            fz = 0.08
            p.box(x0, x1, 1.80, 1.88, z0, z1, 'door_frame', bevel=0.01)
            p.box(x0, x1, 0.03, 0.40, z0, z1, 'door_frame', bevel=0.01)
            p.box(x0, x1, 0.92, 0.98, z0, z1, 'door_frame', bevel=0.01)
            hz0, hz1 = (z0, z0 + fz) if hinge < far else (z1 - fz, z1)
            p.box(x0, x1, 0.40, 1.80, hz0, hz1, 'door_frame', bevel=0.01)
            ez0, ez1 = (z1 - 0.05, z1) if hinge < far else (z0, z0 + 0.05)
            p.box(x0 - 0.01, x1 + 0.01, 0.40, 1.80, ez0, ez1, 'trim_dark')
            gz0, gz1 = (hz1, ez0) if hinge < far else (ez1, hz0)
            p.box(x0 + 0.02, x1 - 0.02, 0.40, 0.92, gz0, gz1, 'glass')
            p.box(x0 + 0.02, x1 - 0.02, 0.98, 1.80, gz0, gz1, 'glass')
            out.append((p, (2.58, 0.0, hinge)))
    return out

def build_signs():
    f = Part('sign_front')
    y0, y1, z = 1.96, 2.21, Z_FRONT + 0.05
    f.quad((-1.12, y0, z), (1.12, y0, z), (1.12, y1, z), (-1.12, y1, z), 'sign_black')
    b = Part('sign_back')
    z = Z_TAIL - 0.07
    # 从车后看（朝 +z 看），右手是 -x，所以 UV 的 u 要沿 -x 走字才不反。
    b.quad((0.45, 1.78, z), (-0.45, 1.78, z), (-0.45, 1.97, z), (0.45, 1.97, z), 'sign_black')
    return [(f, (0, 0, 0)), (b, (0, 0, 0))]

def build_bus():
    build_chassis()
    lower, near_up, far_up = build_sides()
    interior = Part('bus_interior')
    tail_up = build_tail(lower)
    nose_up = build_nose(lower, interior)
    floor = build_interior(interior)
    for p in (lower, near_up, far_up, tail_up, nose_up, interior, floor):
        p.finalize(BUS)
    for p, o in build_wheels() + build_doors() + build_signs():
        p.finalize(BUS, origin=o)

# ================================================================= 城市
KIT = new_coll('KIT')
SIDEWALK_Y = GROUND_Y + 0.18

def railing(p, a, b, h=1.05):
    """沿 a->b（xz）的一段护栏：立柱 + 上下两道横杆。"""
    a, b = Vector((a[0], 0, a[1])), Vector((b[0], 0, b[1]))
    n = max(1, int(math.ceil((b - a).length / 0.9)))
    for i in range(n + 1):
        q = a.lerp(b, i / n)
        p.cyl((q.x, 0, q.z), (q.x, h, q.z), 0.04, 'rail_teal', segs=10)
    for y in (h, 0.55):
        p.cyl((a.x, y, a.z), (b.x, y, b.z), 0.035, 'rail_white', segs=10)

def shelter(p, cx, cz, base_y, length=3.6, depth=1.4, face=-1):
    """候车亭，开口朝 face（-1 = 朝 -x，也就是朝马路）。"""
    x_front = cx + face * depth / 2
    x_back = cx - face * depth / 2
    z0, z1 = cz - length / 2, cz + length / 2
    xb0, xb1 = sorted((x_back, x_back - face * 0.06))
    for x in (x_front, x_back):
        for z in (z0 + 0.1, z1 - 0.1):
            p.cyl((x, base_y, z), (x, base_y + 2.45, z), 0.05, 'shelter_teal', segs=10)
    p.box(xb0, xb1, base_y + 0.3, base_y + 2.3, z0 + 0.15, z1 - 0.15, 'glass')
    xr0, xr1 = sorted((x_front + face * 0.25, x_back - face * 0.1))
    p.box(xr0, xr1, base_y + 2.45, base_y + 2.62, z0 - 0.15, z1 + 0.15, 'shelter_teal', bevel=0.05)
    p.box(xr0, xr1, base_y + 2.40, base_y + 2.46, z0 - 0.12, z1 + 0.12, 'body_white')
    for z in (z0 + 0.1, z1 - 0.1):
        a, b = sorted((x_back, x_back + face * 1.0))
        p.box(a, b, base_y + 0.4, base_y + 2.2, z - 0.03, z + 0.03, 'glass')
    sb0, sb1 = sorted((x_back + face * 0.12, x_back + face * 0.5))
    p.box(sb0, sb1, base_y + 0.42, base_y + 0.5, z0 + 0.5, z1 - 0.5, 'wood', bevel=0.02)
    for z in (z0 + 0.7, z1 - 0.7):
        p.box(sb0 + 0.1, sb1 - 0.1, base_y, base_y + 0.42, z - 0.04, z + 0.04, 'trim_dark')
    # 一侧的灯箱广告
    a, b = sorted((x_back, x_back + face * 0.9))
    p.box(a, b, base_y + 0.35, base_y + 2.2, z1 - 0.05, z1 + 0.05, 'poster', bevel=0.02)

def tree(p, x, z, y, s=1.0):
    p.cyl((x, y, z), (x, y + 1.3 * s, z), 0.14 * s, 'trunk', segs=8)
    p.sphere((x, y + 1.95 * s, z), 0.95 * s, 'leaf_a', subdiv=2)
    p.sphere((x + 0.4 * s, y + 2.5 * s, z + 0.2 * s), 0.72 * s, 'leaf_b', subdiv=2)
    p.sphere((x - 0.38 * s, y + 2.3 * s, z - 0.3 * s), 0.66 * s, 'leaf_a', subdiv=2)

def build_station():
    """始发站：抬高到车厢地板高度的 BRT 式站台，门口一圈排队护栏正好对上碰撞围栏。"""
    st = Part('station')
    X0, X1, Z0, Z1 = 2.75, 11.5, -15.0, 11.0
    st.box(X0, X1, -0.12, 0.0, Z0, Z1, 'station_top', bevel=0.03)
    st.box(X0 + 0.05, X1, GROUND_Y, -0.12, Z0, Z1, 'station_base')
    st.box(X0 + 0.03, X0 + 0.33, -0.02, 0.02, Z0 + 0.1, Z1 - 0.1, 'hazard_yellow')
    step_h = (0.0 - SIDEWALK_Y) / 3
    for k in range(1, 4):
        y = -k * step_h
        st.box(X0, X1, GROUND_Y, y, Z0 - k * 0.6, Z0 - (k - 1) * 0.6, 'station_top', bevel=0.02)
        st.box(X0, X1, GROUND_Y, y, Z1 + (k - 1) * 0.6, Z1 + k * 0.6, 'station_top', bevel=0.02)
    # 排队护栏：沿碰撞围栏的中线
    for r in L['boardingFence']:
        zc = (r['minZ'] + r['maxZ']) / 2
        railing(st, (X0 + 0.12, zc), (L['platformFence']['maxX'] - 0.15, zc))
    pf = L['platformFence']
    xc = (pf['minX'] + pf['maxX']) / 2
    zs = [(r['minZ'] + r['maxZ']) / 2 for r in L['boardingFence']]
    railing(st, (xc, min(zs)), (xc, max(zs)))
    # 候车亭、站牌、树、灌木 —— 全部避开上车机位的视线走廊（z≈-6~1、x>4）。
    shelter(st, 5.8, 3.2, 0.0)
    st.cyl((3.95, 0, -7.2), (3.95, 3.0, -7.2), 0.06, 'trim_dark', segs=10)
    st.box(3.96, 4.06, 1.7, 2.9, -7.78, -6.62, 'sign_teal', bevel=0.02)
    st.box(3.9, 4.1, 2.9, 3.02, -7.82, -6.58, 'hazard_yellow', bevel=0.02)
    for (x, z, s) in ((9.6, -12.0, 1.1), (9.8, -8.6, 0.95), (9.6, 6.0, 1.05), (9.9, 9.2, 1.15)):
        tree(st, x, z, 0.0, s)
    for (x, z) in ((8.0, -10.4), (8.0, 7.6)):
        st.box(x - 0.5, x + 0.5, 0.0, 0.45, z - 0.9, z + 0.9, 'planter', bevel=0.04)
        st.sphere((x, 0.62, z - 0.35), 0.42, 'leaf_b', subdiv=2)
        st.sphere((x, 0.66, z + 0.35), 0.45, 'leaf_a', subdiv=2)
    for z in (-13.0, 1.8, 9.8):
        st.cyl((X0 + 0.45, 0, z), (X0 + 0.45, 0.8, z), 0.09, 'rail_teal', segs=12, bevel=0.03)
    st.finalize(KIT)
    board = Part('station_board')
    x = 4.065
    board.quad((x, 1.78, -6.68), (x, 1.78, -7.72), (x, 2.84, -7.72), (x, 2.84, -6.68), 'sign_teal')
    board.finalize(KIT)

def build_stop():
    """中途站：人行道上的一个候车亭 + 站牌，原点在人行道面。"""
    p = Part('stop')
    shelter(p, 0.75, 0.0, 0.0, length=3.2, depth=1.2)
    p.cyl((0.1, 0, -2.2), (0.1, 2.9, -2.2), 0.06, 'trim_dark', segs=10)
    p.box(0.11, 0.21, 1.8, 2.8, -2.7, -1.7, 'sign_teal', bevel=0.02)
    p.box(0.05, 0.25, 2.8, 2.92, -2.74, -1.66, 'hazard_yellow', bevel=0.02)
    p.finalize(KIT)

def building(name, w, d, floors, wall, awning, tank=False):
    """正面朝 +x，原点在底面中心。w 沿 z（临街面宽），d 沿 x（进深）。"""
    p = Part(name)
    FH = 2.4
    h = floors * FH
    p.box(-d / 2, d / 2, 0.0, 0.3, -w / 2, w / 2, 'bld_base', bevel=0.03)
    p.box(-d / 2, d / 2, 0.3, h, -w / 2, w / 2, wall, bevel=0.06)
    p.box(-d / 2 - 0.12, d / 2 + 0.12, h, h + 0.28, -w / 2 - 0.12, w / 2 + 0.12, 'bld_trim', bevel=0.05)
    p.box(-d / 2 - 0.06, d / 2 + 0.06, FH - 0.08, FH + 0.04, -w / 2 - 0.06, w / 2 + 0.06, 'bld_trim', bevel=0.02)
    # 底商
    p.box(d / 2 - 0.02, d / 2 + 0.03, 0.45, 2.0, -w / 2 + 0.5, w / 2 - 0.5, 'bld_shop')
    p.box(d / 2, d / 2 + 0.9, 2.05, 2.2, -w / 2 + 0.35, w / 2 - 0.35, awning, bevel=0.04, rot_x=0)
    cols_front = max(2, int(w // 1.5))
    cols_side = max(2, int(d // 1.5))
    for f in range(1, floors):
        y0, y1 = f * FH + 0.55, f * FH + 1.85
        for c in range(cols_front):
            z = -w / 2 + (c + 0.5) * w / cols_front
            p.box(d / 2 - 0.02, d / 2 + 0.04, y0, y1, z - 0.42, z + 0.42, 'bld_window')
        for c in range(cols_side):
            x = -d / 2 + (c + 0.5) * d / cols_side
            for sz in (-1, 1):
                a, b = sorted((sz * (w / 2 - 0.02), sz * (w / 2 + 0.04)))
                p.box(x - 0.42, x + 0.42, y0, y1, a, b, 'bld_window')
    if tank:
        p.cyl((0, h + 0.28, -w / 4), (0, h + 1.4, -w / 4), 0.7, 'tank', segs=14, bevel=0.05)
        p.box(-0.9, 0.9, h + 0.28, h + 0.9, w / 8, w / 8 + 1.2, 'bld_trim', bevel=0.04)
    p.finalize(KIT)

def build_kit():
    build_station()
    build_stop()
    building('bld_0', 6.0, 6.0, 4, 'bld_peach', 'awning_coral')
    building('bld_1', 5.0, 5.0, 6, 'bld_mint', 'awning_yellow')
    building('bld_2', 7.0, 6.0, 3, 'bld_lilac', 'awning_teal')
    building('bld_3', 5.0, 5.0, 8, 'bld_sky', 'awning_coral', tank=True)
    t = Part('tree')
    tree(t, 0, 0, 0.0, 1.0)
    t.finalize(KIT)
    lp = Part('lamp')
    lp.cyl((0, 0, 0), (0, 4.2, 0), 0.07, 'lamp_pole', segs=10)
    lp.cyl((0, 4.1, 0), (-1.6, 4.1, 0), 0.05, 'lamp_pole', segs=8)
    lp.box(-1.9, -1.3, 3.92, 4.08, -0.18, 0.18, 'lamp_pole', bevel=0.04)
    lp.box(-1.85, -1.35, 3.88, 3.93, -0.14, 0.14, 'emit_lamp')
    lp.finalize(KIT)
    b = Part('bush')
    b.sphere((0, 0.35, -0.3), 0.5, 'leaf_a', subdiv=2)
    b.sphere((0.1, 0.42, 0.35), 0.55, 'leaf_b', subdiv=2)
    b.finalize(KIT)

# ================================================================= 导出
def export(coll, path):
    keep = set(coll.objects)
    for o in bpy.data.objects:
        o.select_set(o in keep)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=True, export_normals=True,
        export_materials='EXPORT', export_cameras=False, export_lights=False,
        export_vertex_color='MATERIAL', export_meshopt_compression_enable=True)

def stats(coll):
    v = sum(len(o.data.vertices) for o in coll.objects)
    prims = sum(max(1, len(o.data.materials)) for o in coll.objects)
    print(f'[stats] {coll.name}: objects={len(coll.objects)} verts={v} primitives(draw calls)={prims}')

build_bus()
build_kit()
os.makedirs(OUT_DIR, exist_ok=True)
export(BUS, os.path.join(OUT_DIR, 'bus.glb'))
export(KIT, os.path.join(OUT_DIR, 'city.glb'))
stats(BUS)
stats(KIT)
os.makedirs(os.path.dirname(BLEND_PATH), exist_ok=True)
# 不留 .blend1 备份：这个文件每次都由脚本重新生成。
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(BLEND_PATH))
print('[done]', [o.name for o in BUS.objects])
