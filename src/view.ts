// ============================================================================
// Galaxy — 3D Graph ItemView
// ============================================================================
//
// Orchestrates the parser and 3D graph manager within an Obsidian ItemView.
// Manages vault re-parsing, settings panel, and node interaction.
// ============================================================================

import { ItemView, WorkspaceLeaf, debounce, setIcon } from 'obsidian';
import { parseVault } from './parser';
import { GalaxyCustomManager } from './graph3d';
import { ParsedGraph, OrbitPluginSettings, DEFAULT_SETTINGS, SiblingSortMode, OrbitThemeType, OrbitParentSourceType, OrbitTraceStyle, LineToParentStyle } from './types';

export const VIEW_TYPE_ORBIT = '3d-galaxy-graph-view';

export class OrbitGraphView extends ItemView {
	// -- Dependencies --------------------------------------------------------
	private settings: OrbitPluginSettings;
	private saveSettingsCallback?: (settings: OrbitPluginSettings) => Promise<void>;

	// -- Settings Panel UI ---------------------------------------------------
	private settingsPanelEl: HTMLDivElement | null = null;
	private toggleBtnEl: HTMLDivElement | null = null;
	private collapsedSections: Set<string> = new Set(['Theme', 'Organization', 'Display', 'Node Focus']);
	private searchInputEl: HTMLInputElement | null = null;

	// -- Core systems --------------------------------------------------------
	private graph3d: GalaxyCustomManager | null = null;
	private graph: ParsedGraph | null = null;

	// -- Canvas element ------------------------------------------------------
	private containerDiv: HTMLDivElement | null = null;
	private graphContainerEl: HTMLDivElement | null = null;

	// -- Resize observer -----------------------------------------------------
	private resizeObserver: ResizeObserver | null = null;

	// -- Speed toggle state --------------------------------------------------
	private lastActiveSpeed = 5;

	constructor(
		leaf: WorkspaceLeaf,
		settings?: OrbitPluginSettings,
		saveSettingsCallback?: (settings: OrbitPluginSettings) => Promise<void>
	) {
		super(leaf);
		this.settings = settings ?? { ...DEFAULT_SETTINGS };
		this.saveSettingsCallback = saveSettingsCallback;
		if (this.settings.keplerBaseOmega > 0) {
			this.lastActiveSpeed = this.settings.keplerBaseOmega;
		}
	}

	// -----------------------------------------------------------------------
	// ItemView overrides
	// -----------------------------------------------------------------------

	getViewType(): string {
		return VIEW_TYPE_ORBIT;
	}

	getDisplayText(): string {
		return 'Galaxy Graph';
	}

	getIcon(): string {
		return 'orbit';
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();

		// Create wrapper div.
		this.containerDiv = container.createDiv({ cls: 'orbit-graph-container' });

		// Create the 3D graph container div (3d-force-graph injects its canvas here).
		this.graphContainerEl = this.containerDiv.createDiv({ cls: 'orbit-graph-3d-container' });

		// Create settings panel.
		this.createSettingsPanel();

		// Watch for container resizes.
		this.resizeObserver = new ResizeObserver(() => {
			if (this.graph3d && this.graphContainerEl) {
				const g = this.graph3d.getGraph();
				if (g) {
					const rect = this.graphContainerEl.getBoundingClientRect();
					g.width(rect.width);
					g.height(rect.height);
				}
			}
		});
		this.resizeObserver.observe(this.containerDiv);

		// Parse vault and start.
		this.rebuildGraph();

		// Listen for metadata changes (debounced).
		this.registerEvent(
			this.app.metadataCache.on('changed', this.debouncedRebuild),
		);
		this.registerEvent(this.app.vault.on('create', this.debouncedRebuild));
		this.registerEvent(this.app.vault.on('delete', this.debouncedRebuild));
		// Register spacebar shortcut for pause/resume orbit speed
		window.addEventListener('keydown', this.handleKeyDown);
	}

	async onClose(): Promise<void> {
		window.removeEventListener('keydown', this.handleKeyDown);

		// Clean up 3D resources.
		if (this.graph3d) {
			this.graph3d.cleanup();
			this.graph3d = null;
		}

		// Disconnect resize observer.
		this.resizeObserver?.disconnect();

		// Clear DOM.
		this.settingsPanelEl = null;
		this.toggleBtnEl = null;
		this.containerDiv = null;
		this.graphContainerEl = null;
	}

	// -----------------------------------------------------------------------
	// Public API (called by the plugin when settings change)
	// -----------------------------------------------------------------------

	updateSettings(settings: OrbitPluginSettings): void {
		const needsRebuild =
			this.settings.parentSource !== settings.parentSource ||
			this.settings.siblingSortMode !== settings.siblingSortMode ||
			this.settings.orbitDirection !== settings.orbitDirection ||
			this.settings.orbitRadiusScale !== settings.orbitRadiusScale ||
			this.settings.nodeSizeScale !== settings.nodeSizeScale ||
			this.settings.keplerBaseOmega !== settings.keplerBaseOmega;

		this.settings = settings;

		if (needsRebuild) {
			this.rebuildGraph();
		} else if (this.graph3d) {
			this.graph3d.updateSettings(this.settings);
		}

		this.renderSettingsContent();
	}

	// -----------------------------------------------------------------------
	// Graph Rebuild
	// -----------------------------------------------------------------------

	private rebuildGraph(): void {
		this.graph = parseVault(this.app, this.settings);

		// Log any warnings to console.
		for (const w of this.graph.warnings) {
			console.warn(w);
		}

		// Show/hide empty state.
		if (this.graph.roots.length === 0) {
			this.showEmptyState();
		} else {
			this.hideEmptyState();
		}

		if (!this.graphContainerEl) return;

		// Clean up existing 3D graph and preserve focused node.
		let prevFocusedNodeId: string | null = null;
		if (this.graph3d) {
			prevFocusedNodeId = this.graph3d.getFocusedNodeId();
			this.graph3d.cleanup();
		}

		// Create new graph manager and initialize.
		this.graph3d = new GalaxyCustomManager(this.graphContainerEl, this.settings);
		this.graph3d.initialize(this.graph);

		// Set up click handler for opening notes (supports both root and orbital child nodes).
		this.graph3d.setOnNodeClick((nodeId: string) => {
			void this.app.workspace.openLinkText(nodeId, '', false, { active: true });
		});

		// Set up right click handler for camera focus on node (supports both root and orbital child nodes).
		this.graph3d.setOnNodeRightClick((nodeId: string) => {
			this.focusCameraOnNode(nodeId);
		});

		// Sync focus state from 3D scene (right-click, background click, target tracking) to Search Box UI
		this.graph3d.setOnFocusChange((nodeId: string | null) => {
			this.syncSearchInputFocusState(nodeId);
		});
		
		// Restore focus state if it existed before rebuild
		if (prevFocusedNodeId) {
			this.focusCameraOnNode(prevFocusedNodeId);
		}

		const g = this.graph3d.getGraph();
		if (g) {
			// Initial sizing
			const rect = this.graphContainerEl.getBoundingClientRect();
			g.width(rect.width);
			g.height(rect.height);
		}
	}

	private debouncedRebuild = debounce(
		() => this.rebuildGraph(),
		500,
		true,
	);

	// -----------------------------------------------------------------------
	// Empty State
	// -----------------------------------------------------------------------

	private emptyStateEl: HTMLDivElement | null = null;

	private showEmptyState(): void {
		if (this.emptyStateEl || !this.containerDiv) return;
		this.emptyStateEl = this.containerDiv.createDiv({ cls: 'orbit-graph-empty' });

		this.emptyStateEl.createDiv({ text: 'No orbital data found.' });
		const p = this.emptyStateEl.createEl('p');

		const source = this.settings.parentSource || 'frontmatter';
		if (source === 'frontmatter') {
			p.appendText('Add ');
			p.createEl('code', { text: 'gravity_parent' });
			p.appendText(' to your note frontmatter to get started.');
		} else if (source === 'tag') {
			p.appendText('Add tags (e.g. ');
			p.createEl('code', { text: '#parent-note-name' });
			p.appendText(') to your notes to get started.');
		} else if (source === 'outlink') {
			p.appendText('Add outlinks (e.g. ');
			p.createEl('code', { text: '[[Parent Note]]' });
			p.appendText(') to your notes to get started.');
		} else if (source === 'backlink') {
			p.appendText('Add backlinks from other notes to get started.');
		}
	}

	private hideEmptyState(): void {
		this.emptyStateEl?.remove();
		this.emptyStateEl = null;
	}

	// -----------------------------------------------------------------------
	// Settings Panel UI Builder
	// -----------------------------------------------------------------------

	private handleKeyDown = (e: KeyboardEvent): void => {
		if (e.code === 'Space' || e.key === ' ') {
			const target = e.target as HTMLElement;
			if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
				return;
			}
			e.preventDefault();
			this.toggleOrbitPauseResume();
		}
	};

	toggleOrbitPauseResume(): void {
		if (this.settings.keplerBaseOmega > 0) {
			this.lastActiveSpeed = this.settings.keplerBaseOmega;
			this.settings.keplerBaseOmega = 0;
		} else {
			this.settings.keplerBaseOmega = this.lastActiveSpeed > 0 ? this.lastActiveSpeed : 5;
		}
		this.updateDisplaySettings();
		this.renderSettingsContent();
		if (this.saveSettingsCallback) {
			void this.saveSettingsCallback(this.settings);
		}
	}

	/**
	 * Reactive live update for Display settings without unmounting 3D Scene or resetting camera.
	 */
	private updateDisplaySettings(): void {
		if (this.graph3d) {
			this.graph3d.updateSettings(this.settings);
		}
	}

	private createSettingsPanel(): void {
		if (!this.containerDiv) return;

		// 1. Toggle Button
		this.toggleBtnEl = this.containerDiv.createDiv({ cls: 'orbit-graph-settings-toggle' });
		setIcon(this.toggleBtnEl, 'settings');
		this.toggleBtnEl.addEventListener('click', () => {
			this.settingsPanelEl?.classList.toggle('is-hidden');
		});

		// 2. Settings Panel
		this.settingsPanelEl = this.containerDiv.createDiv({ cls: 'orbit-graph-settings-panel is-hidden' });

		// Panel Content Container
		const content = this.settingsPanelEl.createDiv({ cls: 'orbit-graph-settings-content' });

		this.renderSettingsContent(content);
	}

	private renderSettingsContent(container?: HTMLElement): void {
		const parent = container ?? this.settingsPanelEl?.querySelector('.orbit-graph-settings-content') as HTMLElement;
		if (!parent) return;

		parent.empty();

		// --- SECTION 1: Appearance ---
		this.createCollapsibleSection(
			parent,
			'Appearance',
			(secBody) => {
				this.createDropdownSetting(
					secBody,
					'Theme',
					'',
					this.settings.theme,
					[
						{ value: 'light', label: 'Light' },
						{ value: 'dark', label: 'Dark' },
						{ value: 'celestial', label: 'Celestial' }
					],
					async (val) => {
						this.settings.theme = val as OrbitThemeType;
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);
			},
			(actionEl) => {
				const closeBtn = actionEl.createEl('button', { cls: 'orbit-graph-settings-action-btn' });
				setIcon(closeBtn, 'x');
				closeBtn.setAttribute('title', 'Close settings panel');
				closeBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					this.settingsPanelEl?.classList.add('is-hidden');
				});
			}
		);

		// --- SECTION 2: Organization ---
		this.createCollapsibleSection(parent, 'Organization', (secBody) => {
			// Relation Source
			this.createDropdownSetting(
				secBody,
				'Orbit Method',
				'How nodes orbit',
				this.settings.parentSource,
				[
					{ value: 'frontmatter', label: 'Frontmatter' },
					{ value: 'tag', label: 'Tags' },
					{ value: 'outlink', label: 'Outlinks' },
					{ value: 'backlink', label: 'Backlinks' }
				],
				async (val) => {
					this.settings.parentSource = val as OrbitParentSourceType;
					this.rebuildGraph();
					if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
				}
			);

			// Sibling Sort Order
			this.createDropdownSetting(
				secBody,
				'Sibling Sort Order',
				'Same-level node arrangement',
				this.settings.siblingSortMode,
				[
					{ value: 'fileSize', label: 'File Size' },
					{ value: 'createdTime', label: 'Created Time' },
					{ value: 'modifiedTime', label: 'Modified Time' },
					{ value: 'alphabetical', label: 'Alphabetical' }
				],
				async (val) => {
					this.settings.siblingSortMode = val as SiblingSortMode;
					this.rebuildGraph();
					if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
				}
			);

			// Hide Lone Nodes
			this.createCheckboxSetting(
				secBody,
				'Hide Lone Nodes',
				'',
				this.settings.hideLoneNodes ?? false,
				async (val) => {
					this.settings.hideLoneNodes = val;
					this.rebuildGraph();
					if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
				}
			);
		});

		// --- SECTION 3: Display ---
		this.createCollapsibleSection(
			parent,
			'Display',
			(secBody) => {
				// 1. Orbit Speed
				this.createDropdownSetting(
					secBody,
					'Orbit Speed',
					'',
					String(this.settings.keplerBaseOmega),
					[
						{ value: '0', label: 'Stationary' },
						{ value: '2.5', label: 'Slow' },
						{ value: '5', label: 'Moderate' },
						{ value: '10', label: 'Fast' }
					],
					async (val) => {
						const speed = parseFloat(val);
						this.settings.keplerBaseOmega = speed;
						if (speed > 0) {
							this.lastActiveSpeed = speed;
						}
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);

				// 2. Orbit Scale
				this.createDropdownSetting(
					secBody,
					'Orbit Scale',
					'',
					String(this.settings.orbitRadiusScale ?? 1),
					[
						{ value: '0.5', label: 'Small' },
						{ value: '1', label: 'Medium' },
						{ value: '2', label: 'Large' },
					],
					async (val) => {
						const numVal = parseFloat(val);
						this.settings.orbitRadiusScale = numVal;
						this.settings.gravity = numVal;
						this.settings.galaxySize = numVal;
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);

				// 3. Node Size
				this.createDropdownSetting(
					secBody,
					'Node Size',
					'',
					String(this.settings.nodeSizeScale ?? 1),
					[
						{ value: '0.5', label: 'Small' },
						{ value: '1', label: 'Medium' },
						{ value: '2', label: 'Large' },
					],
					async (val) => {
						const numVal = parseFloat(val);
						this.settings.nodeSizeScale = numVal;
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);

				// 4. Orbit Trace
				this.createDropdownSetting(
					secBody,
					'Orbit Trace',
					'',
					this.settings.orbitTraceStyle ?? 'translucent',
					[
						{ value: 'hidden', label: 'Hidden' },
						{ value: 'translucent', label: 'Translucent (50%)' },
						{ value: 'solid', label: 'Solid (100%)' },
					],
					async (val) => {
						this.settings.orbitTraceStyle = val as OrbitTraceStyle;
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);

				// 5. Parent-Child Line
				this.createDropdownSetting(
					secBody,
					'Parent-Child Line',
					'',
					this.settings.lineToParentStyle ?? 'translucent',
					[
						{ value: 'hidden', label: 'Hidden' },
						{ value: 'translucent', label: 'Translucent (50%)' },
						{ value: 'solid', label: 'Solid (100%)' },
					],
					async (val) => {
						this.settings.lineToParentStyle = val as LineToParentStyle;
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);

				// 6. Orbit CCW
				this.createCheckboxSetting(
					secBody,
					'Orbit CCW',
					'Toggle orbit direction',
					(this.settings.orbitDirection ?? 'counterclockwise') === 'counterclockwise',
					async (val) => {
						this.settings.orbitDirection = val ? 'counterclockwise' : 'clockwise';
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);

				// 7. Dual-Parent Oval Orbit
				this.createCheckboxSetting(
					secBody,
					'Dual-Parent Oval Orbit',
					'',
					this.settings.dualParentOvalOrbit ?? true,
					async (val) => {
						this.settings.dualParentOvalOrbit = val;
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);

				// 8. Galactic Rotation
				this.createCheckboxSetting(
					secBody,
					'Galactic Rotation',
					'',
					this.settings.galacticRotation ?? false,
					async (val) => {
						this.settings.galacticRotation = val;
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);

				// 9. Show Axis
				this.createCheckboxSetting(
					secBody,
					'Show Axis',
					'',
					this.settings.showAxis ?? false,
					async (val) => {
						this.settings.showAxis = val;
						this.updateDisplaySettings();
						if (this.saveSettingsCallback) await this.saveSettingsCallback(this.settings);
					}
				);
			},
			(actionEl) => {
				const resetBtn = actionEl.createEl('button', { cls: 'orbit-graph-settings-action-btn' });
				setIcon(resetBtn, 'refresh-cw');
				resetBtn.setAttribute('title', 'Reset display options to default');
				resetBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					void (async () => {
						this.settings.keplerBaseOmega = DEFAULT_SETTINGS.keplerBaseOmega;
						this.settings.orbitDirection = DEFAULT_SETTINGS.orbitDirection;
						this.settings.gravity = DEFAULT_SETTINGS.gravity ?? 1.0;
						this.settings.orbitRadiusScale = (DEFAULT_SETTINGS.gravity ?? 1.0) + 0.5;
						this.settings.galaxySize = (DEFAULT_SETTINGS.gravity ?? 1.0) + 0.5;
						this.settings.nodeSizeScale = DEFAULT_SETTINGS.nodeSizeScale;
						this.settings.orbitTraceStyle = DEFAULT_SETTINGS.orbitTraceStyle ?? 'translucent';
						this.settings.lineToParentStyle = DEFAULT_SETTINGS.lineToParentStyle ?? 'translucent';
						this.settings.dualParentOvalOrbit = DEFAULT_SETTINGS.dualParentOvalOrbit ?? true;
						this.settings.galacticRotation = DEFAULT_SETTINGS.galacticRotation ?? false;
						this.settings.showAxis = DEFAULT_SETTINGS.showAxis ?? false;
						this.lastActiveSpeed = DEFAULT_SETTINGS.keplerBaseOmega;

						this.updateDisplaySettings();
						if (this.saveSettingsCallback) {
							await this.saveSettingsCallback(this.settings);
						}
						this.renderSettingsContent();

						// Auto-fit camera after resetting display settings
						if (this.graph3d) {
							const g = this.graph3d.getGraph();
							if (g && typeof g.zoomToFit === 'function') {
								g.zoomToFit(1000, 100);
							}
						}
					})();
				});
			}
		);

		// --- SECTION 4: Node Focus ---
		this.createCollapsibleSection(parent, 'Node Focus', (secBody) => {
			this.createNodeSearchSetting(secBody);
		});
	}

	private createCollapsibleSection(
		parent: HTMLElement,
		title: string,
		builder: (body: HTMLElement) => void,
		actionBuilder?: (actionEl: HTMLElement) => void
	): void {
		const sec = parent.createDiv({ cls: 'orbit-settings-section' });

		const header = sec.createDiv({ cls: 'orbit-settings-section-header' });

		const titleContainer = header.createDiv({ cls: 'orbit-settings-section-title-container' });
		const iconSpan = titleContainer.createSpan({ cls: 'orbit-settings-section-header-icon' });
		setIcon(iconSpan, 'chevron-down');
		titleContainer.createSpan({ text: title });

		if (actionBuilder) {
			const actionEl = header.createDiv({ cls: 'orbit-settings-section-action' });
			actionBuilder(actionEl);
		}

		const wrapper = sec.createDiv({ cls: 'orbit-settings-section-wrapper' });
		const body = wrapper.createDiv({ cls: 'orbit-settings-section-content' });

		const isCollapsed = this.collapsedSections.has(title);
		if (isCollapsed) {
			wrapper.classList.add('is-collapsed');
			iconSpan.classList.add('is-collapsed');
		}

		header.addEventListener('click', () => {
			const currentlyCollapsed = wrapper.classList.toggle('is-collapsed');
			iconSpan.classList.toggle('is-collapsed', currentlyCollapsed);

			if (currentlyCollapsed) {
				this.collapsedSections.add(title);
			} else {
				this.collapsedSections.delete(title);
			}
		});

		builder(body);
	}

	private createNodeSearchSetting(parent: HTMLElement): void {
		const item = parent.createDiv({ cls: 'orbit-setting-item' });

		const header = item.createDiv({ cls: 'orbit-setting-item-header' });
		header.createDiv({ cls: 'orbit-setting-item-name', text: 'Node Focus' });
		header.createDiv({ cls: 'orbit-setting-item-desc', text: 'Click node name to focus camera' });

		const control = item.createDiv({ cls: 'orbit-setting-item-control' });
		const searchContainer = control.createDiv({ cls: 'orbit-search-container' });

		const input = searchContainer.createEl('input', {
			type: 'text',
			placeholder: 'Search node name...',
			cls: 'orbit-search-input',
		});
		this.searchInputEl = input;

		const clearBtn = searchContainer.createEl('button', {
			cls: 'orbit-search-clear-btn',
			text: '✕',
		});
		clearBtn.setAttribute('title', 'Clear Focus');

		// Autocomplete Dropdown Popup - Appended to containerDiv to prevent clipping by overflow:hidden Settings Panel
		const dropdownEl = this.containerDiv
			? this.containerDiv.createDiv({ cls: 'orbit-autocomplete-dropdown is-hidden' })
			: searchContainer.createDiv({ cls: 'orbit-autocomplete-dropdown is-hidden' });

		const updateDropdownPosition = () => {
			if (!this.containerDiv || dropdownEl.classList.contains('is-hidden')) return;
			const inputRect = input.getBoundingClientRect();
			const containerRect = this.containerDiv.getBoundingClientRect();

			if (inputRect && containerRect) {
				const top = inputRect.bottom - containerRect.top + 4;
				const left = inputRect.left - containerRect.left;
				const width = inputRect.width;

				dropdownEl.setCssStyles({
					position: 'absolute',
					top: `${top}px`,
					left: `${left}px`,
					width: `${width}px`,
					zIndex: '1000'
				});
			}
		};

		const settingsContentEl = this.settingsPanelEl?.querySelector('.orbit-graph-settings-content');
		if (settingsContentEl) {
			settingsContentEl.addEventListener('scroll', () => {
				updateDropdownPosition();
			});
		}

		let currentMatches: { id: string; label: string }[] = [];
		let highlightedIndex = -1;

		const updateHighlight = () => {
			const items = Array.from(dropdownEl.querySelectorAll<HTMLElement>('.orbit-autocomplete-item'));
			items.forEach((itemEl, idx) => {
				if (idx === highlightedIndex) {
					itemEl.classList.add('is-highlighted');
					itemEl.scrollIntoView({ block: 'nearest' });
				} else {
					itemEl.classList.remove('is-highlighted');
				}
			});
		};

		const updateDropdown = () => {
			dropdownEl.empty();
			highlightedIndex = -1;
			currentMatches = [];

			if (!this.graph) {
				dropdownEl.classList.add('is-hidden');
				return;
			}

			const query = input.value.trim().toLowerCase();

			let nodes = Array.from(this.graph.nodes.values());
			if (this.settings.hideLoneNodes) {
				nodes = nodes.filter(
					(node) => node.parents.length > 0 || node.children.length > 0
				);
			}

			nodes.sort((a, b) => a.label.localeCompare(b.label));

			currentMatches = query
				? nodes.filter((node) => node.label.toLowerCase().includes(query))
				: nodes;

			if (currentMatches.length === 0) {
				dropdownEl.classList.add('is-hidden');
				return;
			}

			dropdownEl.classList.remove('is-hidden');
			updateDropdownPosition();

			currentMatches.forEach((node, idx) => {
				const optionEl = dropdownEl.createDiv({
					cls: 'orbit-autocomplete-item',
					text: node.label,
				});

				optionEl.addEventListener('mouseenter', () => {
					highlightedIndex = idx;
					updateHighlight();
				});

				optionEl.addEventListener('mousedown', (e) => {
					e.preventDefault();
					input.value = node.label;
					dropdownEl.classList.add('is-hidden');
					highlightedIndex = -1;

					// Focus camera on selected node via 3d-force-graph
					this.focusCameraOnNode(node.id);
				});
			});
		};

		input.addEventListener('focus', () => {
			updateDropdown();
		});

		input.addEventListener('input', () => {
			if (input.value.trim() === '') {
				this.clearFocusedNode();
			}
			updateDropdown();
		});

		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (dropdownEl.classList.contains('is-hidden')) {
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					updateDropdown();
				}
				return;
			}

			if (currentMatches.length === 0) return;

			if (e.key === 'ArrowDown') {
				e.preventDefault();
				highlightedIndex = (highlightedIndex + 1) % currentMatches.length;
				updateHighlight();
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (highlightedIndex <= 0) {
					highlightedIndex = -1;
					updateHighlight();
				} else {
					highlightedIndex = highlightedIndex - 1;
					updateHighlight();
				}
			} else if (e.key === 'Enter') {
				if (highlightedIndex >= 0 && highlightedIndex < currentMatches.length) {
					e.preventDefault();
					const selectedNode = currentMatches[highlightedIndex];
					if (selectedNode) {
						input.value = selectedNode.label;
						dropdownEl.classList.add('is-hidden');
						highlightedIndex = -1;
						this.focusCameraOnNode(selectedNode.id);
					}
				}
			} else if (e.key === 'Escape') {
				dropdownEl.classList.add('is-hidden');
				highlightedIndex = -1;
			}
		});

		input.addEventListener('blur', () => {
			window.setTimeout(() => {
				dropdownEl.classList.add('is-hidden');
				highlightedIndex = -1;
			}, 150);
		});

		clearBtn.addEventListener('click', () => {
			this.clearFocusedNode();
			dropdownEl.classList.add('is-hidden');
			highlightedIndex = -1;
		});
	}

	/**
	 * Synchronize the search box text input value with the active node focus state.
	 */
	private syncSearchInputFocusState(nodeId: string | null): void {
		if (this.searchInputEl) {
			if (nodeId && this.graph) {
				const node = this.graph.nodes.get(nodeId);
				this.searchInputEl.value = node ? node.label : '';
			} else {
				this.searchInputEl.value = '';
			}
		}
	}

	/**
	 * Focus the 3D camera on a specific node (parent or child) by ID and track its orbital path continuously.
	 */
	private focusCameraOnNode(nodeId: string | null): void {
		if (!nodeId) {
			this.clearFocusedNode();
			return;
		}
		if (this.graph3d) {
			this.graph3d.setFocusedNode(nodeId);
		}
		this.syncSearchInputFocusState(nodeId);
	}

	private clearFocusedNode(): void {
		if (this.graph3d) {
			this.graph3d.clearFocusedNode();
		}
		this.syncSearchInputFocusState(null);
	}

	private createDropdownSetting(
		parent: HTMLElement,
		name: string,
		desc: string,
		currentValue: string,
		options: { value: string; label: string }[],
		onChange: (value: string) => Promise<void>
	): void {
		const item = parent.createDiv({ cls: 'orbit-setting-item' });

		const header = item.createDiv({ cls: 'orbit-setting-item-header' });
		header.createDiv({ cls: 'orbit-setting-item-name', text: name });
		if (desc) {
			header.createDiv({ cls: 'orbit-setting-item-desc', text: desc });
		}

		const control = item.createDiv({ cls: 'orbit-setting-item-control' });
		const select = control.createEl('select');

		for (const opt of options) {
			select.createEl('option', { value: opt.value, text: opt.label });
		}

		select.value = currentValue;

		select.addEventListener('change', () => {
			void onChange(select.value);
		});
	}

	private createSliderSetting(
		parent: HTMLElement,
		name: string,
		desc: string,
		currentValue: number,
		min: number,
		max: number,
		step: number,
		onChange: (value: number) => Promise<void>
	): void {
		const item = parent.createDiv({ cls: 'orbit-setting-item' });

		const header = item.createDiv({ cls: 'orbit-setting-item-header' });
		header.createDiv({ cls: 'orbit-setting-item-name', text: name });
		if (desc) {
			header.createDiv({ cls: 'orbit-setting-item-desc', text: desc });
		}

		const control = item.createDiv({ cls: 'orbit-setting-item-control' });
		const container = control.createDiv({ cls: 'orbit-setting-slider-container' });

		const slider = container.createEl('input', { type: 'range' });
		slider.min = String(min);
		slider.max = String(max);
		slider.step = String(step);
		slider.value = String(currentValue);

		const valueEl = container.createSpan({ cls: 'orbit-setting-slider-value', text: String(currentValue) });

		slider.addEventListener('input', () => {
			valueEl.setText(slider.value);
		});

		slider.addEventListener('change', () => {
			const val = parseFloat(slider.value);
			if (!isNaN(val)) {
				void onChange(val);
			}
		});
	}

	private createCheckboxSetting(
		parent: HTMLElement,
		name: string,
		desc: string,
		currentValue: boolean,
		onChange: (value: boolean) => Promise<void>
	): void {
		const item = parent.createDiv({ cls: 'orbit-setting-item' });

		const container = item.createDiv({ cls: 'orbit-setting-checkbox-container' });

		const checkbox = container.createEl('input', { type: 'checkbox' });
		checkbox.checked = currentValue;
		checkbox.id = 'orbit-settings-' + name.replace(/\s+/g, '-').toLowerCase();

		const label = container.createEl('label', { cls: 'orbit-setting-checkbox-label' });
		label.setAttribute('for', checkbox.id);

		label.createSpan({ cls: 'orbit-setting-item-name', text: ' ' + name });
		if (desc) {
			label.createEl('br');
			label.createSpan({ cls: 'orbit-setting-item-desc', text: desc });
		}

		checkbox.addEventListener('change', () => {
			void onChange(checkbox.checked);
		});
	}
}
