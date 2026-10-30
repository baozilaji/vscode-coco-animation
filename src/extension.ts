import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface AtlasPair { plistPath: string; pngPath: string; }

/** 发现与 ExportJson 配套的 plist / png 图集（支持 config_file_path 与同目录 <base>N 两种布局） */
function discoverAtlases(dir: string, base: string, jsonObj: any): AtlasPair[] {
	let pairs: AtlasPair[] = [];
	const cfp: any = jsonObj && jsonObj.config_file_path;
	const cpp: any = jsonObj && jsonObj.config_png_path;
	if (Array.isArray(cfp) && cfp.length) {
		cfp.forEach((p: string, i: number) => {
			const plistPath = path.resolve(dir, p);
			const pngPath = (Array.isArray(cpp) && cpp[i]) ? path.resolve(dir, cpp[i]) : plistPath.replace(/\.plist$/i, '.png');
			pairs.push({ plistPath, pngPath });
		});
		pairs = pairs.filter(p => fs.existsSync(p.plistPath) && fs.existsSync(p.pngPath));
	}
	// 兜底：config_file_path 缺失或指向已损坏的路径时，扫描同目录 <base>N.plist
	if (pairs.length === 0) {
		let files: string[] = [];
		try { files = fs.readdirSync(dir); } catch { files = []; }
		const safeBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp('^' + safeBase + '\\d+\\.plist$', 'i');
		const plists = files.filter(f => re.test(f)).sort();
		const list = plists.length ? plists : [base + '0.plist'];
		for (const pf of list) {
			const plistPath = path.join(dir, pf);
			const pngPath = plistPath.replace(/\.plist$/i, '.png');
			pairs.push({ plistPath, pngPath });
		}
		pairs = pairs.filter(p => fs.existsSync(p.plistPath) && fs.existsSync(p.pngPath));
	}
	return pairs;
}

function pngDataUrl(pngPath: string): string {
	const buf = fs.readFileSync(pngPath);
	const ext = path.extname(pngPath).toLowerCase();
	const mime = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
	return `data:${mime};base64,${buf.toString('base64')}`;
}

function readTextSafe(p: string): string {
	try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

const panels = new Map<string, vscode.WebviewPanel>();

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('coco-animation-viewer.preview', async (uri?: vscode.Uri) => {
			let target = uri;
			if (!target) {
				const ed = vscode.window.activeTextEditor;
				if (ed && /\.ExportJson$/i.test(ed.document.fileName)) target = ed.document.uri;
			}
			if (!target) {
				const picked = await vscode.window.showOpenDialog({
					canSelectMany: false,
					filters: { 'CocoStudio ExportJson': ['ExportJson'] }
				});
				if (picked && picked[0]) target = picked[0];
			}
			if (!target) return;
			await showCocoPanel(context, target);
		})
	);
}

async function showCocoPanel(context: vscode.ExtensionContext, uri: vscode.Uri) {
	const fsPath = uri.fsPath;
	const dir = path.dirname(fsPath);
	const base = path.basename(fsPath).replace(/\.ExportJson$/i, '');

	let jsonObj: any = null;
	let jsonText = '';
	try {
		jsonText = fs.readFileSync(fsPath, 'utf8');
		jsonObj = JSON.parse(jsonText);
	} catch (e) {
		vscode.window.showErrorMessage('无法读取 / 解析 ExportJson: ' + String(e));
		return;
	}

	const pairs = discoverAtlases(dir, base, jsonObj);
	const atlases = pairs.map(p => ({ plistText: readTextSafe(p.plistPath), pngDataUrl: pngDataUrl(p.pngPath) }));

	const column = vscode.ViewColumn.Beside;
	let panel = panels.get(fsPath);
	if (panel) {
		panel.reveal(column);
		return;
	}

	panel = vscode.window.createWebviewPanel('cocoAnimation', `动画: ${base}`, column, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'webview')]
	});
	panels.set(fsPath, panel);
	panel.onDidDispose(() => panels.delete(fsPath));

	const webview = panel.webview;
	const csp = webview.cspSource;
	const coreUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'src', 'webview', 'coco-core.js'));
	const panelJsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'src', 'webview', 'panel.js'));
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'src', 'webview', 'panel.css'));

	let html = fs.readFileSync(vscode.Uri.joinPath(context.extensionUri, 'src', 'webview', 'panel.html').fsPath, 'utf8');
	html = html
		.replace(/CSP_SOURCE/g, csp)
		.replace(/PANEL_CSS_URI/g, cssUri.toString())
		.replace(/COCO_CORE_URI/g, coreUri.toString())
		.replace(/PANEL_JS_URI/g, panelJsUri.toString());
	webview.html = html;

	webview.onDidReceiveMessage((msg: any) => {
		if (msg && msg.type === 'ready') {
			webview.postMessage({ type: 'load', fileName: base, jsonText, atlases });
		} else if (msg && msg.type === 'error') {
			vscode.window.showErrorMessage('动画预览: ' + String(msg.message));
		}
	});
}

export function deactivate() { }
