/* 逻辑验证：用真实 ExportJson + plist 验证 coco-core 的移植正确性（无需浏览器）。 */
const fs = require('fs');
const path = require('path');
const COCO = require('../src/webview/coco-core.js');

// 本地测试资源目录（需指向含 ani_chao_yue.ExportJson / .plist / .png 的文件夹）。
// 为避免把机器相关的绝对路径写进工程，改为通过环境变量注入：
//   COCO_TEST_RES=/your/path/ani_chao_yue node test/verify.js
const RES = process.env.COCO_TEST_RES;
if (!RES) {
	console.log('跳过 verify：未设置环境变量 COCO_TEST_RES（本地测试资源目录）');
	process.exit(0);
}
const json = JSON.parse(fs.readFileSync(path.join(RES, 'ani_chao_yue.ExportJson'), 'utf8'));
const plistText = fs.readFileSync(path.join(RES, 'ani_chao_yue0.plist'), 'utf8');

function parseRectsPlist(text) {
	const rects = {};
	const re = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
	let m;
	while ((m = re.exec(text))) {
		const key = m[1], body = m[2];
		if (key === 'frames') continue;
		const g = n => { const mm = new RegExp('<key>' + n + '</key>\\s*<(?:integer|real)>([^<]+)<').exec(body); return mm ? +mm[1] : 0; };
		const w = Math.round(g('width')), h = Math.round(g('height'));
		if (!w || !h) continue; // 跳过非切片项（如 frames 容器本身）
		rects[key] = { x: Math.round(g('x')), y: Math.round(g('y')), w, h, atlas: 0, rotated: false };
	}
	return rects;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
	if (cond) { pass++; console.log('  ✓ ' + name); }
	else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('== 解析 ani_chao_yue ==');
const model = COCO.buildModel(json, [{ plistText: '', image: null }]);
ok('movs 数量 = 6', model.movs.length === 6, 'got ' + model.movs.length);
ok('bones 数量 > 0', model.bones.length > 0, 'got ' + model.bones.length);

// 默认动作应为互斥变体里「最饱满」的那条（骨骼数×时长最大）
const expectedDefault = (() => {
	let bi = 0, best = -1;
	model.movs.forEach((m, i) => { const s = Object.keys(m.byBone).length * Math.max(1, m.dr); if (s > best) { best = s; bi = i; } });
	return bi;
})();
ok('默认 activeMov = 最饱满动作 (' + expectedDefault + ')', model.runtime.activeMov === expectedDefault, 'got ' + model.runtime.activeMov);
ok('默认动作下存在互斥排除骨 (exclude>0)', model.runtime.exclude.size > 0, 'size=' + model.runtime.exclude.size);
ok('默认动作 totalFrames>0', model.runtime.totalFrames > 0, 'got ' + model.runtime.totalFrames);

// 切换到合并全部
COCO.selectMovement(model, -1);
ok('合并模式 exclude 为空', model.runtime.exclude.size === 0, 'size=' + model.runtime.exclude.size);
const mergedFrames = model.runtime.totalFrames;
ok('合并模式时长 = 最大 dr+1', mergedFrames === Math.max(...model.movs.map(m => m.dr)) + 1, 'got ' + mergedFrames);

// poseAt：取一个有动画的骨，在其某个可见关键帧（dI>=0）应给出具体 disp 名
COCO.selectMovement(model, expectedDefault);
const drivenBone = model.bones.find(b => b.kfs.length > 0);
const visibleKf = drivenBone.kfs.find(k => k.dI >= 0) || drivenBone.kfs[0];
const p0 = COCO.poseAt(drivenBone, visibleKf.fi);
ok('poseAt 在可见帧返回 disp', typeof p0.disp === 'string' && p0.disp.length > 0, JSON.stringify(p0));
ok('poseAt 坐标有限', Number.isFinite(p0.x) && Number.isFinite(p0.y), JSON.stringify(p0));
ok('dI<0 帧 disp 为 null/未绘制', (() => {
	const kfNeg = drivenBone.kfs.find(k => k.dI < 0);
	if (!kfNeg) return true;
	const p = COCO.poseAt(drivenBone, kfNeg.fi);
	return p.disp === null;
})(), 'dI<0 应被隐藏');

// activeBounds 有限
const bb = COCO.activeBounds(model);
ok('activeBounds 四个值均有限', bb.every(Number.isFinite), JSON.stringify(bb));

// 注入真实 plist 切片 + 假图，做 drawFrame 变换测试（mock canvas ctx）
const rects = parseRectsPlist(plistText);
ok('plist 解析出 28 个切片', Object.keys(rects).length === 28, 'got ' + Object.keys(rects).length);
Object.assign(model.plist, rects);
model.atlases = [{ naturalWidth: 1024, naturalHeight: 1024 }];

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
