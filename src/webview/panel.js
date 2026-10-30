/*
 * panel.js —— VS Code webview 中的 UI 与交互层。
 * 依赖 coco-core.js 暴露的全局函数：buildModel / selectMovement / drawFrame / poseAt / activeBounds 等。
 */
(function () {
	'use strict';
	const vscode = acquireVsCodeApi();

	let MODEL = null;
	let curFrame = 0, fps = 30, playing = false, timer = null, zoom = 1, loopEnabled = true;

	const $ = id => document.getElementById(id);
	const cv = $('cv');
	const ctx = cv.getContext('2d');

	// 告知扩展：webview 已就绪，可以接收数据
	vscode.postMessage({ type: 'ready' });

	window.addEventListener('message', ev => {
		const m = ev.data;
		if (m && m.type === 'load') onLoad(m);
	});

	function onLoad(m) {
		try {
			const json = JSON.parse(m.jsonText);
			const atlases = (m.atlases || []).map(a => ({ plistText: a.plistText, image: null, pngDataUrl: a.pngDataUrl }));
			let pending = atlases.length;
			if (!pending) { buildAndShow(json, atlases, m.fileName); return; }
			atlases.forEach(a => {
				const img = new Image();
				img.onload = () => { a.image = img; if (--pending === 0) buildAndShow(json, atlases, m.fileName); };
				img.onerror = () => { a.image = null; if (--pending === 0) buildAndShow(json, atlases, m.fileName); };
				img.src = a.pngDataUrl;
			});
		} catch (e) {
			showError(e);
		}
	}

	function showError(e) {
		$('title').textContent = '加载失败: ' + (e && e.message ? e.message : e);
		vscode.postMessage({ type: 'error', message: String(e) });
	}

	function buildAndShow(json, atlases, fileName) {
		MODEL = buildModel(json, atlases);
		curFrame = 0; zoom = 1;
		$('title').textContent = '动画预览: ' + fileName + '  (' + MODEL.bones.length + ' 骨 / ' + MODEL.movs.length + ' 动作)';
		buildMovDropdown();
		buildBoneList();
		$('zoomSlider').value = 100; $('zoomLabel').textContent = '100%';
		updateSliderMax();
		renderPreview();
		renderAtlas();
		renderGrid();
	}

	/* ---------- 动作下拉 ---------- */
	function buildMovDropdown() {
		const sel = $('movSel');
		sel.innerHTML = '';
		if (MODEL.movs.length > 1) {
			const o = document.createElement('option');
			o.value = '-1'; o.textContent = '合并全部动作 (' + MODEL.movs.length + '个)';
			sel.appendChild(o);
		}
		MODEL.movs.forEach((m, i) => {
			const o = document.createElement('option');
			o.value = String(i);
			o.textContent = '[' + i + '] ' + m.name + ' · ' + Object.keys(m.byBone).length + '骨 · ' + m.dr + '帧';
			sel.appendChild(o);
		});
		sel.value = String(MODEL.runtime.activeMov < 0 ? -1 : MODEL.runtime.activeMov);
		sel.onchange = () => applyMov(parseInt(sel.value, 10));
	}

	function applyMov(idx) {
		selectMovement(MODEL, idx);
		MODEL.runtime.zoom = zoom;
		buildMovDropdown();
		buildBoneList();
		updateSliderMax();
		renderPreview();
		renderGrid();
	}

	/* ---------- 骨骼可见性 ---------- */
	function buildBoneList() {
		const box = $('boneList');
		box.innerHTML = '';
		MODEL.bones.forEach(b => {
			const row = document.createElement('label');
			row.className = 'boneRow';
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = !MODEL.runtime.hide.has(b.name);
			cb.onchange = () => {
				if (cb.checked) MODEL.runtime.hide.delete(b.name);
				else MODEL.runtime.hide.add(b.name);
				renderPreview();
			};
			const span = document.createElement('span');
			const isOther = MODEL.runtime.exclude.has(b.name);
			span.textContent = b.name + (isOther ? '  ·[其它动作]' : '');
			if (isOther) span.className = 'otherMov';
			row.appendChild(cb); row.appendChild(span);
			box.appendChild(row);
		});
	}

	/* ---------- 预览渲染 ---------- */
	function updateSliderMax() {
		$('frameSlider').max = String(Math.max(0, MODEL.runtime.totalFrames - 1));
	}

	function renderPreview() {
		if (!MODEL) return;
		const w = cv.clientWidth, h = cv.clientHeight;
		if (cv.width !== w) cv.width = w;
		if (cv.height !== h) cv.height = h;
		drawFrame(ctx, MODEL, curFrame, w, h);
	}

	function updateFrame() {
		$('frameSlider').value = String(curFrame);
		$('frameLabel').textContent = (curFrame + 1) + ' / ' + MODEL.runtime.totalFrames;
		renderPreview();
	}

	/* ---------- 播放控制 ---------- */
	function play() {
		if (playing) return;
		playing = true; $('playBtn').textContent = '⏸ 暂停';
		timer = setInterval(() => {
			let nf = curFrame + 1;
			if (nf >= MODEL.runtime.totalFrames) {
				if (loopEnabled || MODEL.runtime.loop) nf = 0;
				else { nf = MODEL.runtime.totalFrames - 1; stop(); }
			}
			curFrame = nf; updateFrame();
		}, 1000 / fps);
	}
	function stop() {
		playing = false; $('playBtn').textContent = '▶ 播放';
		if (timer) { clearInterval(timer); timer = null; }
	}

	/* ---------- 图集页 ---------- */
	function renderAtlas() {
		const box = $('atlasBox');
		box.innerHTML = '';
		MODEL.atlases.forEach((img, ai) => {
			if (!img) return;
			const wrap = document.createElement('div');
			wrap.className = 'atlasItem';
			const h = document.createElement('div');
			h.className = 'atlasTitle';
			h.textContent = '图集 #' + ai + '  (' + img.naturalWidth + '×' + img.naturalHeight + ', ' +
				Object.values(MODEL.plist).filter(r => r.atlas === ai).length + ' 切片)';
			wrap.appendChild(h);
			const c = document.createElement('canvas');
			const maxW = 560;
			const sc = Math.min(1, maxW / img.naturalWidth);
			c.width = Math.max(1, Math.round(img.naturalWidth * sc));
			c.height = Math.max(1, Math.round(img.naturalHeight * sc));
			const g = c.getContext('2d');
			g.drawImage(img, 0, 0, c.width, c.height);
			g.strokeStyle = '#ff5555'; g.lineWidth = 1;
			for (const k in MODEL.plist) {
				const r = MODEL.plist[k];
				if (r.atlas !== ai) continue;
				g.strokeRect(r.x * sc, r.y * sc, r.w * sc, r.h * sc);
			}
			wrap.appendChild(c);
			box.appendChild(wrap);
		});
	}

	/* ---------- 动作总览网格 ---------- */
	function withMov(ad, idx, fn) {
		const saved = ad.bones.map(b => b.kfs.slice());
		const sMov = ad.runtime.activeMov, sExc = new Set(ad.runtime.exclude),
			sTot = ad.runtime.totalFrames, sName = ad.runtime.movName, sLoop = ad.runtime.loop;
		selectMovement(ad, idx);
		try { fn(); } finally {
			ad.bones.forEach((b, i) => { b.kfs = saved[i]; });
			ad.runtime.activeMov = sMov; ad.runtime.exclude = sExc;
			ad.runtime.totalFrames = sTot; ad.runtime.movName = sName; ad.runtime.loop = sLoop;
		}
	}

	function renderGrid() {
		const box = $('gridBox');
		box.innerHTML = '';
		if (MODEL.movs.length < 2) { box.textContent = '该动画只有 1 个动作，无需总览。'; return; }
		const items = [{ idx: -1, label: '合并全部动作' }];
		MODEL.movs.forEach((m, i) => items.push({ idx: i, label: '[' + i + '] ' + m.name + '  ' + Object.keys(m.byBone).length + '骨 · ' + m.dr + '帧' }));
		items.forEach(it => {
			const cell = document.createElement('div');
			cell.className = 'gridCell';
			if (it.idx === MODEL.runtime.activeMov) cell.classList.add('active');
			const c = document.createElement('canvas');
			c.width = 180; c.height = 180;
			withMov(MODEL, it.idx, () => {
				drawFrame(c.getContext('2d'), MODEL, Math.min(5, MODEL.runtime.totalFrames - 1), 180, 180);
			});
			const cap = document.createElement('div');
			cap.className = 'gridCap';
			cap.textContent = it.label;
			cell.appendChild(c); cell.appendChild(cap);
			cell.onclick = () => { applyMov(it.idx); renderGrid(); };
			box.appendChild(cell);
		});
	}

	/* ---------- 控件事件 ---------- */
	$('playBtn').onclick = () => { playing ? stop() : play(); };
	$('loopChk').onchange = e => { loopEnabled = e.target.checked; };
	$('frameSlider').oninput = e => { curFrame = parseInt(e.target.value, 10); updateFrame(); };
	$('fpsInput').onchange = e => { fps = clamp(parseInt(e.target.value, 10) || 30, 1, 60); };
	$('zoomSlider').oninput = e => {
		zoom = parseInt(e.target.value, 10) / 100;
		$('zoomLabel').textContent = e.target.value + '%';
		if (MODEL) { MODEL.runtime.zoom = zoom; renderPreview(); }
	};

	document.querySelectorAll('.tabBtn').forEach(btn => {
		btn.onclick = () => {
			document.querySelectorAll('.tabBtn').forEach(b => b.classList.remove('active'));
			document.querySelectorAll('.tabPanel').forEach(p => p.classList.remove('active'));
			btn.classList.add('active');
			const panel = $('panel' + btn.dataset.tab);
			if (panel) panel.classList.add('active');
			if (btn.dataset.tab === 'Preview') renderPreview();
		};
	});

	// 尺寸变化时重绘预览
	if (typeof ResizeObserver !== 'undefined') {
		const ro = new ResizeObserver(() => renderPreview());
		ro.observe(cv.parentElement);
	}
	function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
})();
