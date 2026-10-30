/*
 * coco-core.js —— CocoStudio 动画三件套的解析与渲染核心逻辑。
 * 与原始 Java 版 AnimationViewer 的算法 1:1 对齐：
 *   parsePlistXml / buildModel / selectMovement / pickDefaultMov /
 *   computeExclude / poseAt / activeBounds / drawFrame
 * 既可在浏览器 (VS Code webview) 中以全局函数方式被 panel.js 调用，
 * 也可在 Node 中 require 用于单元测试（无 DOM 依赖的部分）。
 */
(function (global) {
	'use strict';

	// 调试开关（与 Java 端一致）
	const FLAGS = { HIDE_STATIC_DINEG: false, DINEG_USE_BIND: false };

	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

	/* ----------------------- plist (XML) 解析 ----------------------- */
	// 兼容两种常见格式：
	//   1) Zwoptex/老 TP "format 0"：每帧含 x/y/width/height/offsetX... 直接键
	//   2) TexturePacker：每帧含 frame="{{x,y},{w,h}}" + rotated + sourceSize
	function parsePlistXml(text) {
		if (typeof DOMParser === 'undefined') return {}; // Node 测试环境：返回空，由调用方注入
		const doc = new DOMParser().parseFromString(text, 'application/xml');
		const map = {};
		const keys = doc.getElementsByTagName('key');
		for (let i = 0; i < keys.length; i++) {
			if (keys[i].textContent === 'frames') {
				let n = keys[i].nextSibling;
				while (n && !(n.nodeType === 1 && n.tagName === 'dict')) n = n.nextSibling;
				if (n) parseFrameDict(n, map);
				break;
			}
		}
		return map;
	}
	function childVal(dictEl, name) {
		const ks = dictEl.getElementsByTagName('key');
		for (let i = 0; i < ks.length; i++) {
			if (ks[i].textContent === name) {
				let n = ks[i].nextSibling;
				while (n && n.nodeType !== 1) n = n.nextSibling;
				return n ? n.textContent : null;
			}
		}
		return null;
	}
	function parseFrameDict(dict, map) {
		const ch = dict.childNodes; let key = null;
		for (let i = 0; i < ch.length; i++) {
			const e = ch[i];
			if (e.nodeType !== 1) continue;
			if (e.tagName === 'key') key = e.textContent;
			else if (e.tagName === 'dict') {
				if (key) { const r = parseRect(e); if (r) map[key] = r; key = null; }
			}
		}
	}
	function parseRect(dictEl) {
		let x = 0, y = 0, w = 0, h = 0;
		const frameStr = childVal(dictEl, 'frame');
		if (frameStr) {
			const m = /^\{\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\},\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}\}/.exec(frameStr);
			if (m) { x = +m[1]; y = +m[2]; w = +m[3]; h = +m[4]; }
		} else {
			x = +(childVal(dictEl, 'x') || 0);
			y = +(childVal(dictEl, 'y') || 0);
			w = +(childVal(dictEl, 'width') || 0);
			h = +(childVal(dictEl, 'height') || 0);
		}
		const rotated = childVal(dictEl, 'rotated') === 'true' || childVal(dictEl, 'rotated') === true;
		if (!w && !h) return null;
		return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), rotated: !!rotated, atlas: 0 };
	}

	/* ----------------------- 模型构建 ----------------------- */
	function buildModel(json, atlases) {
		const ad = {};
		ad.armatureName = (json.armature_data && json.armature_data[0] && json.armature_data[0].name)
			|| (json.animation_data && json.animation_data[0] && json.animation_data[0].name);
		ad.bones = [];
		ad.byName = {};
		ad.movs = [];
		ad.plist = {};
		ad.atlases = (atlases || []).map(a => a.image);

		// --- armature / bones ---
		const arm = json.armature_data && json.armature_data[0];
		if (arm && arm.bone_data) {
			for (const b of arm.bone_data) {
				const bone = {
					name: b.name,
					parent: b.parent || '',
					bx: +b.x || 0, by: +b.y || 0, bz: +b.z || 0,
					bkX: +b.kX || 0,
					bcX: b.cX == null ? 1 : +b.cX,
					bcY: b.cY == null ? 1 : +b.cY,
					bindDI: b.dI == null ? 0 : Math.trunc(+b.dI),
					visible: b.visible == null ? true : (b.visible !== 0 && b.visible !== '0'),
					displays: (b.display_data || []).map(d => d.name),
					bindDisplay: null,
					kfs: [] // 运行时由 selectMovement 填充
				};
				bone.bindDisplay = bone.displays.length ? bone.displays[0] : null;
				ad.bones.push(bone);
				ad.byName[bone.name] = bone;
			}
		}

		// --- animation / movement ---
		// 一个 armature 下可有多个 mov_data（如 ani_chao_yue 的 dig1..dig6 是互斥的完整角色变体）。
		const anim = json.animation_data && json.animation_data[0];
		if (anim && anim.mov_data) {
			for (const mobj of anim.mov_data) {
				const mvd = {
					name: mobj.name,
					dr: 0,
					loop: (mobj.lp === 'true' || mobj.lp === true),
					scale: mobj.sc == null ? 1 : +mobj.sc,
					byBone: {}
				};
				let maxFi = 0;
				for (const mb of (mobj.mov_bone_data || [])) {
					const bn = mb.name;
					if (!ad.byName[bn]) continue;
					const ks = [];
					for (const f of (mb.frame_data || [])) {
						const kf = {
							fi: f.fi == null ? 0 : Math.trunc(+f.fi),
							dI: f.dI == null ? -1000 : Math.trunc(+f.dI),
							tween: f.tweenFrame !== false,
							x: +f.x || 0, y: +f.y || 0,
							kX: f.kX == null ? 0 : +f.kX,
							kY: f.kY == null ? 0 : +f.kY,
							cX: f.cX == null ? 1 : +f.cX,
							cY: f.cY == null ? 1 : +f.cY,
							a: f.color ? (+f.color.a / 255) : 1
						};
						ks.push(kf);
						if (kf.fi > maxFi) maxFi = kf.fi;
					}
					ks.sort((a, b) => a.fi - b.fi);
					mvd.byBone[bn] = ks;
				}
				mvd.dr = mobj.dr == null ? maxFi : Math.trunc(+mobj.dr);
				ad.movs.push(mvd);
			}
		}
		if (!ad.movs.length) ad.movs.push({ name: '(默认)', dr: 0, loop: false, scale: 1, byBone: {} });

		// --- plist 图集切片 ---
		(atlases || []).forEach((a, ai) => {
			const sub = parsePlistXml(a.plistText || '');
			for (const k in sub) { sub[k].atlas = ai; ad.plist[k] = sub[k]; }
		});

		ad.runtime = { activeMov: -2, totalFrames: 1, loop: false, scale: 1, movName: '', exclude: new Set(), hide: new Set(), zoom: 1 };
		selectMovement(ad, pickDefaultMov(ad));
		return ad;
	}

	/* ----------------------- 动作切换 ----------------------- */
	// idx = -1 表示「合并全部动作」：每根骨取关键帧最多的那条时间线
	function selectMovement(ad, idx) {
		ad.runtime.activeMov = idx;
		if (idx >= 0 && idx < ad.movs.length) {
			const m = ad.movs[idx];
			ad.runtime.movName = m.name; ad.runtime.loop = m.loop; ad.runtime.scale = m.scale;
			ad.runtime.totalFrames = m.dr + 1;
			for (const b of ad.bones) b.kfs = m.byBone[b.name] ? m.byBone[b.name].slice() : [];
		} else {
			ad.runtime.movName = '(合并全部动作)';
			let mx = 0, lp = false;
			for (const b of ad.bones) {
				let best = null;
				for (const m of ad.movs) {
					const ks = m.byBone[b.name];
					if (ks && (!best || ks.length > best.length)) best = ks;
				}
				b.kfs = best ? best.slice() : [];
			}
			for (const m of ad.movs) { if (m.dr > mx) mx = m.dr; if (m.loop) lp = true; }
			ad.runtime.totalFrames = mx + 1; ad.runtime.loop = lp;
		}
		ad.runtime.exclude = computeExclude(ad);
	}

	// 默认选中第几个动作：-1 = 合并全部
	function pickDefaultMov(ad) {
		if (ad.movs.length < 2) return 0;
		const keysOf = m => Object.keys(m.byBone);
		let inter = new Set(keysOf(ad.movs[0]));
		const uni = new Set(inter);
		for (const m of ad.movs) {
			for (const k of keysOf(m)) uni.add(k);
			for (const k of Array.from(inter)) if (!(k in m.byBone)) inter.delete(k);
		}
		if (uni.size === inter.size) return 0; // 各动作驱动同一批骨 -> 第一条即可
		// 互斥变体 -> 取「最饱满」的那条：骨骼数 × 时长
		let bi = 0, best = -1;
		for (let i = 0; i < ad.movs.length; i++) {
			const s = keysOf(ad.movs[i]).length * Math.max(1, ad.movs[i].dr);
			if (s > best) { best = s; bi = i; }
		}
		return bi;
	}

	// 与本动作互斥的骨骼集合：被其它 movement 驱动、但不被当前 movement 驱动
	function computeExclude(ad) {
		const s = new Set();
		if (!ad || ad.movs.length < 2 || ad.runtime.activeMov < 0) return s;
		const cur = ad.movs[ad.runtime.activeMov];
		for (const m of ad.movs) { if (m === cur) continue; for (const k of Object.keys(m.byBone)) s.add(k); }
		for (const k of Object.keys(cur.byBone)) s.delete(k);
		return s;
	}

	/* ----------------------- 姿态计算 ----------------------- */
	function isHidden(ad, name) { return ad.runtime.hide.has(name) || ad.runtime.exclude.has(name); }

	function staticDisp(b) {
		if (!b.visible) return null;
		if (b.bindDI >= 0 && b.bindDI < b.displays.length) return b.displays[b.bindDI];
		return FLAGS.HIDE_STATIC_DINEG ? null : b.bindDisplay;
	}

	function activeKF(b, f) {
		if (!b.kfs.length) return null;
		let a = b.kfs[0];
		for (const k of b.kfs) { if (k.fi <= f) a = k; else break; }
		return a;
	}

	// 计算某骨骼在指定帧的绘制姿态（插值）
	function poseAt(b, f) {
		const p = { disp: null, x: 0, y: 0, sx: 1, sy: 1, a: 1, rot: 0 };
		if (b.kfs.length === 0) {
			p.disp = staticDisp(b); p.x = b.bx; p.y = b.by; p.a = 1; p.sx = b.bcX; p.sy = b.bcY; p.rot = b.bkX; return p;
		}
		const a = activeKF(b, f);
		p.x = a.x; p.y = a.y; p.a = a.a; p.sx = a.cX * b.bcX; p.sy = a.cY * b.bcY; p.rot = a.kX;
		// dI<0：该帧不绘制
		p.disp = (a.dI >= 0 && a.dI < b.displays.length) ? b.displays[a.dI] : (FLAGS.DINEG_USE_BIND ? b.bindDisplay : null);
		const idx = b.kfs.indexOf(a);
		if (a.tween && idx + 1 < b.kfs.length && f < b.kfs[idx + 1].fi) {
			const b2 = b.kfs[idx + 1];
			const t = (f - a.fi) / (b2.fi - a.fi);
			p.x = a.x + (b2.x - a.x) * t; p.y = a.y + (b2.y - a.y) * t; p.a = a.a + (b2.a - a.a) * t;
			p.sx = (a.cX + (b2.cX - a.cX) * t) * b.bcX; p.sy = (a.cY + (b2.cY - a.cY) * t) * b.bcY;
			p.rot = a.kX + (b2.kX - a.kX) * t;
		}
		p.x += b.bx; p.y += b.by;
		return p;
	}

	/* 计算取景框：只统计当前会绘制的骨（用渲染位置，避免被远处 bind 撑大） */
	function activeBounds(ad) {
		let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
		const N = Math.max(1, ad.runtime.totalFrames);
		const step = Math.max(1, Math.floor(N / 60));
		for (let f = 0; f < N; f += step) {
			for (const b of ad.bones) {
				if (isHidden(ad, b.name)) continue;
				const p = poseAt(b, f);
				if (!p.disp || p.a <= 0.02) continue;
				let r = ad.plist[p.disp];
				let w = 0, h = 0;
				if (r) { w = r.w; h = r.h; }
				else { for (const dn of b.displays) { const rr = ad.plist[dn]; if (rr) { w = Math.max(w, rr.w); h = Math.max(h, rr.h); } } }
				const hw = Math.abs(w * p.sx) / 2, hh = Math.abs(h * p.sy) / 2;
				let ehw = hw, ehh = hh;
				if (p.rot) { const rad = Math.hypot(hw, hh); ehw += rad; ehh += rad; }
				const x0 = p.x - ehw, x1 = p.x + ehw, y0 = p.y - ehh, y1 = p.y + ehh;
				if (x0 < minX) minX = x0; if (x1 > maxX) maxX = x1;
				if (y0 < minY) minY = y0; if (y1 > maxY) maxY = y1;
			}
		}
		if (minX > maxX) { minX = minY = -200; maxX = maxY = 200; }
		return [minX, minY, maxX, maxY];
	}

	/* 把指定帧绘制到任意 Canvas 2D 上下文：黑底、自动适配视图 */
	function drawFrame(ctx, ad, f, w, h) {
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, w, h);
		if (!ad || !ad.atlases || !ad.atlases.length) return;
		ctx.imageSmoothingEnabled = true;

		const b = activeBounds(ad);
		const bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
		const pad = 24;
		const sc = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh) * (ad.runtime.zoom || 1);
		const cxw = (b[0] + b[2]) / 2, cyw = (b[1] + b[3]) / 2;
		const cx = w / 2, cy = h / 2;

		const order = ad.bones.slice().sort((a, c) => a.bz - c.bz);
		for (const bone of order) {
			if (isHidden(ad, bone.name)) continue;
			const p = poseAt(bone, f);
			const r = p.disp ? ad.plist[p.disp] : null;
			if (!r) continue;
			const src = ad.atlases[r.atlas];
			if (!src) continue;
			ctx.globalAlpha = clamp(p.a, 0, 1);
			const sx = cx + (p.x - cxw) * sc;
			const sy = cy - (p.y - cyw) * sc;
			ctx.save();
			ctx.translate(sx, sy);
			ctx.rotate(-p.rot * Math.PI / 180);
			if (r.rotated) {
				// 图集中以 90° 存储：源矩形为 (x,y,h,w)，绘制时整体旋 90°
				const sw = r.h, sh = r.w;
				ctx.rotate(Math.PI / 2);
				const hw = (r.h / 2) * p.sx * sc, hh = (r.w / 2) * p.sy * sc;
				ctx.drawImage(src, r.x, r.y, sw, sh, -hh, -hw, hh * 2, hw * 2);
			} else {
				const hw = (r.w / 2) * p.sx * sc, hh = (r.h / 2) * p.sy * sc;
				ctx.drawImage(src, r.x, r.y, r.w, r.h, -hw, -hh, hw * 2, hh * 2);
			}
			ctx.restore();
		}
		ctx.globalAlpha = 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
	}

	const API = {
		FLAGS, parsePlistXml, buildModel, selectMovement, pickDefaultMov, computeExclude,
		poseAt, activeBounds, staticDisp, isHidden, drawFrame
	};
	if (typeof module !== 'undefined' && module.exports) module.exports = API;
	if (typeof window !== 'undefined') Object.assign(window, API);
})(typeof globalThis !== 'undefined' ? globalThis : this);
