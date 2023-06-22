import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { copyFile, cp, rm } from 'fs/promises';
import { App, ItemView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import * as which from 'which';

// Remember to rename these classes and interfaces!
enum HexoPostType {
	HEXO_POST = "_posts", 
	HEXO_DRAFT = "_drafts"
}

interface HexoHelperSettings {
	hexoPath: string;
	npxPath: string;
	hexoPort: number
}
const DEFAULT_SETTINGS: HexoHelperSettings = {
	hexoPath: "",
	hexoPort: 4000,
	npxPath: ""
}

const HEXO_VIEW_TYPE = "hexo-view"

class HexoView extends ItemView {
	private frame: HTMLIFrameElement;
	private plugin: HexoHelper;

	constructor(leaf: WorkspaceLeaf, plugin: HexoHelper) {
		super(leaf)
		this.plugin = plugin
	}

	getViewType(): string {
		return HEXO_VIEW_TYPE
	}

	getDisplayText(): string {
		return "Hexo Preview"
	}

	async onOpen() {
		this.contentEl.empty();

		this.frame = document.createElement("webview") as HTMLIFrameElement;
        this.frame.setAttribute("allowpopups", "");
        // CSS classes makes frame fill the entire tab's content space.
        this.frame.addClass("hexo-view-frame");
        this.contentEl.addClass("hexo-view-content");
        this.contentEl.appendChild(this.frame);

		this.frame.setAttribute("src", "http://127.0.0.1:" + this.plugin.settings.hexoPort);
	}

	async onClose() {
		if (this.plugin.previewProcess!.exitCode != null) {
			return
		}
		if (!this.plugin.previewProcess!.kill(2)) {
			new Notice("[Hexo Helper]  Failed to Stop Local Hexo Server.")
		}
		// stop preview process
	}
}

export default class HexoHelper extends Plugin {
	settings: HexoHelperSettings;
	previewProcess: undefined | ChildProcess;
	publishProcess: undefined | ChildProcess;

	async activateView() {
		this.app.workspace.detachLeavesOfType(HEXO_VIEW_TYPE);
	
		await this.app.workspace.getLeaf(true).setViewState({
		  type: HEXO_VIEW_TYPE,
		  active: true,
		});
	
		this.app.workspace.revealLeaf(
		  this.app.workspace.getLeavesOfType(HEXO_VIEW_TYPE)[0]
		);
	}

	async preview() {
		if (this.settings.hexoPath.trim() == "") {
			new Notice("[Hexo Helper] Please set hexo project path in settings.")
			return
		}
		this.stopPreview()
		const [_file, status] = await this.copyFiles(HexoPostType.HEXO_DRAFT);
		if (!status) { return }
		
		const previewProcess = spawn(this.settings.npxPath!, [
			"hexo", "serve", 
			"--draft",
			"-g", 
			"-i", "127.0.0.1", 
			"-p", this.settings.hexoPort.toString()
		], 
		{
			cwd: this.settings.hexoPath.toString()
		});
		
		this.previewProcess = previewProcess;
		previewProcess.on("error", err => {
			new Notice("[Hexo Helper] Local Hexo Server Error: " + err.message)
		})
		previewProcess.on("exit", code => {
			// potential error
			if (code != 0 && code != null) {
				new Notice("[Hexo Helper] Local Hexo Server Error: Code " + code)
			}
			new Notice("[Hexo Helper] Local Hexo Server Stopped")
		})
		previewProcess.stderr.on("data", data => {
			new Notice("[Hexo Helper] Local Hexo Server Error: " + data)
		})

		previewProcess.stdout.on("data", async data => {
			const buf: string = data.toString()
			if (buf.contains("Press Ctrl+C to stop.")) {
				new Notice("[Hexo Helper] Local Hexo Server Running.")
				await this.activateView()
			}
		})
	}

	async publish() {
		if (this.settings.hexoPath.trim() == "") {
			new Notice("[Hexo Helper] Please set hexo project path in settings.")
			return
		}
		const [file, status] = await this.copyFiles(HexoPostType.HEXO_POST);
		if (!status) { return }
		
		const publishProcess = spawn(this.settings.npxPath!, [
			"hexo", "deploy", 
			"-g"
		], 
		{
			cwd: this.settings.hexoPath.toString()
		});
		
		this.publishProcess = publishProcess;
		publishProcess.on("error", err => {
			new Notice("[Hexo Helper] Hexo Publish Error: " + err.message)
		})
		publishProcess.on("exit", code => {
			// potential error
			if (code != 0 && code != null) {
				new Notice("[Hexo Helper] Hexo Publish Error: Code " + code)
			} else {
				new Notice("[Hexo Helper] Blog Published")
				// delete drafts if exists 
				this.removeDrafts(file!)
			}
		})
		publishProcess.stderr.on("data", data => {
			new Notice("[Hexo Helper] Hexo Publish Error: " + data)
		})
	}

	async removeDrafts(file: TFile) {
		await rm(path.join(this.settings.hexoPath, "source", HexoPostType.HEXO_DRAFT))
		await rm(path.join(this.settings.hexoPath, "source", HexoPostType.HEXO_DRAFT), {
			recursive: true
		})
	}

	async copyFiles(ty: HexoPostType): Promise<[TFile | null, boolean]> {
		const file = this.app.workspace.getActiveFile()
		if (file == null) {
			new Notice("[Hexo Helper] Please run when a file is opened.")
			return [file, false]
		}

		if (file.extension != "md") {
			new Notice("[Hexo Helper] A markdown file is needed.")
			return [file, false]
		}

		//@ts-ignore
		const vaultPath = this.app.vault.adapter.basePath;
		const filePath = path.join(vaultPath, file.path);
		const assetsPath = path.join(vaultPath, "assets", file.basename);
		
		await cp(assetsPath, path.join(this.settings.hexoPath, "source", ty, file.basename), {
			recursive: true
		})
		await copyFile(filePath, path.join(this.settings.hexoPath, "source", ty, file.name))
		return [file, true]
	}

	async onload() {
		await this.loadSettings();

		// register hexo view
		this.registerView(HEXO_VIEW_TYPE, leaf => new HexoView(leaf, this))

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new HexoHelperSettingTab(this.app, this));
		
		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
		
		// set npx path
		if (this.settings.npxPath.trim() == '') {
			const npxPath = which.sync("npx", { nothrow: true });
			if (npxPath != null) {
				this.settings.npxPath = npxPath
				await this.saveSettings()
			} else {
				new Notice("[Hexo Helper] You need to set npx path in settings first.")
				return
			}
		}

		this.addRibbonIcon('pencil', 'Hexo Preview', async (evt: MouseEvent) => {
			new Notice("[Hexo Helper] Preview Current Note")
			await this.preview()
		})
		this.addRibbonIcon('enter', 'Hexo Publish', async (evt: MouseEvent) => {
			new Notice("[Hexo Helper] Publish Current Note")
			await this.publish()
		})
	}

	stopPreview() {
		this.app.workspace.detachLeavesOfType(HEXO_VIEW_TYPE);

		if (this.previewProcess != undefined && this.previewProcess.exitCode == null) {
			if (!this.previewProcess.kill(2)) {
				new Notice("[Hexo Helper] Failed to kill preview process.")
			}
		}
	}

	onunload() {
		this.stopPreview()
		if (this.publishProcess != undefined && this.publishProcess.exitCode == null) {
			if (!this.publishProcess.kill(2)) {
				new Notice("[Hexo Helper] Failed to kill publish process.")
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class HexoHelperSettingTab extends PluginSettingTab {
	plugin: HexoHelper;

	constructor(app: App, plugin: HexoHelper) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Hexo Helper Settings'});
		
		new Setting(containerEl)
			.setName('NPX Path')
			.setDesc('The path to npx executable')
			.addText(text => text
				.setPlaceholder('Enter the path')
				.setValue(this.plugin.settings.npxPath)
				.onChange(async (value) => {
					this.plugin.settings.npxPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hexo Project Folder')
			.setDesc('The root path of your hexo blog')
			.addText(text => text
				.setPlaceholder('Enter your path')
				.setValue(this.plugin.settings.hexoPath)
				.onChange(async (value) => {
					this.plugin.settings.hexoPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hexo Preview Port')
			.setDesc('The listening port when previewing blog')
			.addText(text => text
				.setPlaceholder('Enter the port')
				.setValue(this.plugin.settings.hexoPort.toString())
				.onChange(async (value) => {
					this.plugin.settings.hexoPort = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
