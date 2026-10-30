/* 逻辑验证：用真实 ExportJson + plist 验证 coco-core 的移植正确性（无需浏览器）。
 *
 * 默认测试资源为工程内置样例：test/Samples/ani_loading_demo
 *   （含 ani_loading_demo.ExportJson / ani_loading_demo0.plist / ani_loading_demo0.png）
 * 可用环境变量覆盖到其它资产目录（目录内任意 *.ExportJson 都会被自动识别）：
 *   COCO_TEST_RES=/your/path/ani_chao_yue node test/verify.js
 */
const fs = require('fs');
const path = require('path');
const COCO = require('../src/webview/coco-core.js');

// 解析默认值：仓库内置样例；允许 COCO_TEST_RES 覆盖到外部目录
const DEFAULT_SAMPLE = path.join(__dirname, 'Samples', 'ani_loading_demo');
const RES = process.env.COCO_TEST_RES || DEFAULT_SAMPLE;
if (!fs.existsSync(RES)) {
	console.log('跳过 verify：测试资源目录不存在 -> ' + RES);
	process.exit(0);
}

// 在目录中自动定位 *.ExportJson 并推导基名（兼容 ani_loading_demo / ani_chao_yue 等任意资产）
function resolveBase(dir) {
	const ej = fs.readdirSync(dir).find(f => f.endsWith('.ExportJson'));
	if (!ej) throw new Error('在 ' + dir + ' 未找到 *.ExportJson');
	return ej.slice(0, -'.ExportJson'.length);
}
const BASE = resolveBase(RES);
const json = JSON.parse(fs.readFileSync(path.join(RES, BASE + '.ExportJson'), 'utf8'));
const plistText = fs.readFileSync(path.join(RES, BASE + '0.plist'), 'utf8');

// 取 frames 容器的完整内容：用括号配平，避免外层 <dict> 把首个切片吞掉
function framesBody(text) {
	const i = text.indexOf('<key>frames</key>');
	if (i < 0) return text;
	const di = text.indexOf('<dict>', i);
	if (di < 0) return text;
	let depth = 0, k = di;
	while (k < text.length) {
		if (text.startsWith('<dict>', k)) { depth++; k += 6; }
		else if (text.startsWith('</dict>', k)) { depth--; k += 7; if (depth === 0) break; }
		else k++;
	}
	return text.slice(di, k);
}

function parseRectsPlist(text) {
	const rects = {};
	const re = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
	let m;
	while ((m = re.exec(framesBody(text)))) {
		const key = m[1], body = m[2];
		if (key === 'frames' || key === 'metadata') continue;
		const g = n => { const mm = new RegExp('<key>' + n + '</key>\\s*<(?:integer|real)>([^<]+)<').exec(body); return mm ? +mm[1] : 0; };
		const w = Math.round(g('width')), h = Math.round(g('height'));
		if (!w || !h) continue; // 跳过非切片项
		rects[key] = { x: Math.round(g('x')), y: Math.round(g('y')), w, h, atlas: 0, rotated: false };
	}
	return rects;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
	if (cond) { pass++; console.log('  ✓ ' + name); }
	else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('== 解析 ' + BASE + ' ==');
const model = COCO.buildModel(json, [{ plistText: '', image: null }]);
ok('bones 数量 = 4', model.bones.length === 4, 'got ' + model.bones.length);
ok('bones 名含 label/dot1/dot2/dot3',
	['label', 'dot1', 'dot2', 'dot3'].every(n => model.byName[n]),
	model.bones.map(b => b.name).join(','));

ok('movs 数量 = 1', model.movs.length === 1, 'got ' + model.movs.length);
ok('mov 名 = loop', model.movs[0] && model.movs[0].name === 'loop', model.movs[0] && model.movs[0].name);
ok('pickDefaultMov = 0（单动作直接选）', COCO.pickDefaultMov(model) === 0, 'got ' + COCO.pickDefaultMov(model));

// 默认已进入单动作：loop=true，时长 dr+1=4，无互斥排除骨
ok('runtime.loop = true（lp:true）', model.runtime.loop === true, 'got ' + model.runtime.loop);
ok('runtime.totalFrames = 4（dr 3 +1）', model.runtime.totalFrames === 4, 'got ' + model.runtime.totalFrames);
ok('单动作下 exclude 为空', model.runtime.exclude.size === 0, 'size=' + model.runtime.exclude.size);

// 重新选回该动作，确认一致性
COCO.selectMovement(model, 0);
ok('重选后 loop 仍为 true', model.runtime.loop === true);
ok('重选后 totalFrames = 4', model.runtime.totalFrames === 4);

// poseAt：dot1 在 fi=0 可见（dI=0, alpha=255 -> a=1）
const dot1 = model.byName.dot1;
const pDot1 = COCO.poseAt(dot1, 0);
ok('dot1 可见帧 disp = "dot"', pDot1.disp === 'dot', JSON.stringify(pDot1));
ok('dot1 可见帧 alpha = 1', Math.abs(pDot1.a - 1) < 1e-6, 'a=' + pDot1.a);
ok('poseAt 坐标有限', Number.isFinite(pDot1.x) && Number.isFinite(pDot1.y), JSON.stringify(pDot1));

// poseAt：dot2 在 fi=0 的 color.a=0 -> alpha=0（但仍应给出 disp，隐藏靠 alpha 而非 disp）
const dot2 = model.byName.dot2;
const pDot2 = COCO.poseAt(dot2, 0);
ok('dot2 fi0 disp 仍为 "dot"（dI=0）', pDot2.disp === 'dot', JSON.stringify(pDot2));
ok('dot2 fi0 alpha = 0（color.a=0 解析正确）', Math.abs(pDot2.a - 0) < 1e-6, 'a=' + pDot2.a);

// dI<0 隐藏规则：独立单元验证（不依赖具体资产）
const fakeNeg = { name: 't', displays: ['x'], bindDisplay: 'x', bindDI: 0, visible: true, bx: 0, by: 0, bcX: 1, bcY: 1, bkX: 0, kfs: [{ fi: 0, dI: -1, tween: false, x: 0, y: 0, kX: 0, kY: 0, cX: 1, cY: 1, a: 1 }] };
const fakePos = { name: 't', displays: ['x'], bindDisplay: 'x', bindDI: 0, visible: true, bx: 0, by: 0, bcX: 1, bcY: 1, bkX: 0, kfs: [{ fi: 0, dI: 0, tween: false, x: 0, y: 0, kX: 0, kY: 0, cX: 1, cY: 1, a: 1 }] };
ok('dI<0 帧 disp 为 null（隐藏）', COCO.poseAt(fakeNeg, 0).disp === null);
ok('dI>=0 帧 disp 取自 displays', COCO.poseAt(fakePos, 0).disp === 'x');

// activeBounds 有限
const bb = COCO.activeBounds(model);
ok('activeBounds 四个值均有限', bb.every(Number.isFinite), JSON.stringify(bb));

// 注入真实 plist 切片 + 假图，做 drawFrame 变换测试（mock canvas ctx）
const rects = parseRectsPlist(plistText);
ok('plist 解析出 2 个切片', Object.keys(rects).length === 2, 'got ' + Object.keys(rects).length);
ok('切片 loading 尺寸 70x14', rects.loading && rects.loading.w === 70 && rects.loading.h === 14, JSON.stringify(rects.loading));
ok('切片 dot 尺寸 14x14', rects.dot && rects.dot.w === 14 && rects.dot.h === 14, JSON.stringify(rects.dot));
Object.assign(model.plist, rects);
model.atlases = [{ naturalWidth: 128, naturalHeight: 128 }];

const calls = [];
const mockCtx = {
	setTransform() { }, fillRect() { }, save() { }, restore() { },
	translate() { }, rotate() { }, set fillStyle(v) { }, set imageSmoothingEnabled(v) { },
	set globalAlpha(v) { },
	drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
		calls.push({ sx, sy, sw, sh, dx, dy, dw, dh });
	}
};
COCO.drawFrame(mockCtx, model, 0, 800, 600);
ok('drawFrame 对可见骨调用 drawImage', calls.length > 0, 'calls=' + calls.length);
const bad = calls.find(c => !Number.isFinite(c.dx) || !Number.isFinite(c.dy) || !(c.dw > 0) || !(c.dh > 0));
ok('所有 drawImage 目标矩形有限且正尺寸', !bad, bad ? JSON.stringify(bad) : '');
const srcOk = calls.find(c => c.sw > 0 && c.sh > 0);
ok('源切片尺寸来自 plist', !!srcOk, srcOk ? JSON.stringify({ sw: srcOk.sw, sh: srcOk.sh }) : 'none');

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
