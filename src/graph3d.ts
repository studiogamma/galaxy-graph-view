// ============================================================================
// Galaxy — 3D Force-Directed Graph with Flat-Scene Orbital Mechanics
// ============================================================================
//
// Architecture:
// - Parent (root) nodes are managed by 3d-force-graph's d3-force-3d engine.
// - Child (orbiting) nodes are flat top-level scene objects, NOT registered
//   with the force engine. Their world positions are computed each tick via
//   orbital math equations referencing parent world positions.
// - Multi-parent support: N=1 circular, N=2 elliptical, N≥3 centroid.
// - All orbital planes are parallel to XY (z = parent.z).
// ============================================================================

import * as THREE from 'three';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ForceGraph3D from '3d-force-graph';
import SpriteText from 'three-spritetext';
import type { ParsedGraph, GraphNode, OrbitPluginSettings } from './types';
import { THEMES, getNodeColor } from './renderer';

// ---------------------------------------------------------------------------
// Constants (ported from physics.ts)
// ---------------------------------------------------------------------------

const BASE_NODE_SCALE = 30;
const BASE_ORBIT_SCALE = 240;

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/** Node data fed to 3d-force-graph's graphData (all nodes in vault). */
interface ForceNode {
	id: string;
	label: string;
	renderRadius: number;
	color: string;
	depth: number;
	systemMaxDepth: number;
	group: string;
	targetX?: number;
	targetY?: number;
	targetZ?: number;
	/** Populated at runtime by d3-force-3d */
	x?: number;
	y?: number;
	z?: number;
}

/** Link data fed to 3d-force-graph's graphData (parent-to-parent only). */
interface ForceLink {
	source: string;
	target: string;
}

/** Flat orbital child node — exists only as scene objects + math state with LOD. */
interface OrbitalChild {
	id: string;
	label: string;
	parentIds: string[];
	depth: number;
	theta: number;
	omega: number;
	orbitRadius: number;
	renderRadius: number;
	siblingIndex: number;
	systemMaxDepth: number;
	color: string;
	lod: THREE.LOD;
	orbitTraceObj?: THREE.LineLoop;
	parentLineObjs?: THREE.Line[];
}

// ---------------------------------------------------------------------------
// Orbital sizing (ported from physics.ts)
// ---------------------------------------------------------------------------

function getNodeRelativeSizes(
	nodeId: string,
	depth: number,
	maxDepth: number
): { nodeRadius: number; orbitRadius: number } {
	if (nodeId.startsWith('virtual-tag:')) {
		return { nodeRadius: 1, orbitRadius: 0 };
	}
	const d = Math.max(0, depth);

	if (maxDepth === 0) return { nodeRadius: 0.7, orbitRadius: 0 };
	if (maxDepth === 1) {
		if (d === 0) return { nodeRadius: 1, orbitRadius: 0 };
		return { nodeRadius: 0.5, orbitRadius: 1 };
	}
	if (maxDepth === 2) {
		if (d === 0) return { nodeRadius: 1, orbitRadius: 0 };
		if (d === 1) return { nodeRadius: 0.5, orbitRadius: 1 };
		return { nodeRadius: 0.25, orbitRadius: 1 / 3 };
	}
	if (maxDepth === 3) {
		if (d === 0) return { nodeRadius: 2, orbitRadius: 0 };
		if (d === 1) return { nodeRadius: 1, orbitRadius: 3 };
		if (d === 2) return { nodeRadius: 0.5, orbitRadius: 1 };
		return { nodeRadius: 0.25, orbitRadius: 1 / 3 };
	}
	// maxDepth >= 4
	if (d === 0) return { nodeRadius: 4, orbitRadius: 0 };
	const nodeRadius = 4 * Math.pow(0.5, d);
	const orbitRadius = 9 * Math.pow(1 / 3, d - 1);
	return { nodeRadius, orbitRadius };
}

// ---------------------------------------------------------------------------
// Graph3DManager
// ---------------------------------------------------------------------------

export class Graph3DManager {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private graph: any = null;
	private containerEl: HTMLElement;
	private settings: OrbitPluginSettings;

	/** Force-managed parent nodes keyed by id. */
	private forceNodes: Map<string, ForceNode> = new Map();

	/** Flat orbital children keyed by id. */
	private orbitalChildren: Map<string, OrbitalChild> = new Map();

	/** Ordered list of child IDs by depth (parents before children). */
	private orderedChildIds: string[] = [];

	/** System max depth per root subtree (nodeId → maxDepth). */
	private systemMaxDepths: Map<string, number> = new Map();

	/** Sorted children cache: parentId → sorted childId[] */
	private sortedChildrenCache: Map<string, string[]> = new Map();

	/** Reusable sphere geometries for variable resolution (LOD). */
	private geoHigh: THREE.SphereGeometry = new THREE.SphereGeometry(1, 32, 16);
	private geoMid: THREE.SphereGeometry = new THREE.SphereGeometry(1, 20, 10);
	private geoLow: THREE.SphereGeometry = new THREE.SphereGeometry(1, 12, 6);

	/** Animation frame handle for continuous rAF orbital animation. */
	private animFrameId: number | null = null;

	/** Last frame timestamp for dt calculation. */
	private lastTickTime: number = 0;

	constructor(containerEl: HTMLElement, settings: OrbitPluginSettings) {
		this.containerEl = containerEl;
		this.settings = settings;
	}

	private onNodeClickCallback: ((nodeId: string) => void) | null = null;
	private onNodeRightClickCallback: ((nodeId: string) => void) | null = null;
	private clickPointerDownPos: { x: number; y: number } | null = null;
	private isPointerListenerSetup: boolean = false;

	private focusedNodeId: string | null = null;
	private cameraOffset: THREE.Vector3 = new THREE.Vector3(0, 0, 400);

	/**
	 * Get the 3D world position for any node (either force-managed parent node or flat orbital child node).
	 */
	getNodeWorldPosition(nodeId: string): { x: number; y: number; z: number } | null {
		const forceNode = this.forceNodes.get(nodeId);
		if (forceNode && forceNode.x !== undefined && forceNode.y !== undefined) {
			return { x: forceNode.x, y: forceNode.y, z: forceNode.z ?? 0 };
		}

		const orbChild = this.orbitalChildren.get(nodeId);
		if (orbChild) {
			return {
				x: orbChild.lod.position.x,
				y: orbChild.lod.position.y,
				z: orbChild.lod.position.z,
			};
		}

		return null;
	}

	/**
	 * Focus camera on a node and continuously track/follow its 3D orbital movement in real time.
	 */
	setFocusedNode(nodeId: string | null): void {
		this.focusedNodeId = nodeId;
		if (!nodeId || !this.graph) return;

		const targetPos = this.getNodeWorldPosition(nodeId);
		if (!targetPos) return;

		const camera = this.graph.camera();
		if (camera) {
			const currentCamPos = camera.position;
			const dx = currentCamPos.x - targetPos.x;
			const dy = currentCamPos.y - targetPos.y;
			const dz = currentCamPos.z - targetPos.z;
			const dist = Math.hypot(dx, dy, dz);

			if (dist > 50 && dist < 5000) {
				this.cameraOffset.set(dx, dy, dz);
			} else {
				this.cameraOffset.set(0, 0, 400);
			}

			const newCamPos = {
				x: targetPos.x + this.cameraOffset.x,
				y: targetPos.y + this.cameraOffset.y,
				z: targetPos.z + this.cameraOffset.z,
			};

			this.graph.cameraPosition(newCamPos, { x: targetPos.x, y: targetPos.y, z: targetPos.z }, 1000);
		}
	}

	clearFocusedNode(): void {
		this.focusedNodeId = null;
	}

	/**
	 * Register callback for node left click (supports both force root nodes and flat orbital child nodes).
	 */
	setOnNodeClick(callback: (nodeId: string) => void): void {
		this.onNodeClickCallback = callback;
		if (this.graph) {
			this.graph.onNodeClick((node: object) => {
				const n = node as { id?: string };
				if (n.id && !n.id.startsWith('virtual-tag:')) {
					callback(n.id);
				}
			});
		}
	}

	/**
	 * Register callback for node right click (supports both force root nodes and flat orbital child nodes).
	 */
	setOnNodeRightClick(callback: (nodeId: string) => void): void {
		this.onNodeRightClickCallback = callback;
		if (this.graph) {
			this.graph.onNodeRightClick((node: object) => {
				const n = node as { id?: string };
				if (n.id) {
					callback(n.id);
				}
			});
		}
	}

	/**
	 * Perform 3D raycasting at mouse pointer location to identify any parent or orbital child node.
	 * Returns the node ID if hit, or null if empty space (background).
	 */
	raycastNodeAtPointer(e: PointerEvent): string | null {
		if (!this.graph) return null;
		const camera = this.graph.camera();
		if (!camera || !this.containerEl) return null;

		const rect = this.containerEl.getBoundingClientRect();
		const mouse = new THREE.Vector2(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-((e.clientY - rect.top) / rect.height) * 2 + 1
		);

		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(mouse, camera);

		const targets: THREE.Object3D[] = [];
		const objectToNodeIdMap = new Map<THREE.Object3D, string>();

		// 1. Add flat orbital child nodes
		for (const [childId, child] of this.orbitalChildren.entries()) {
			targets.push(child.lod);
			objectToNodeIdMap.set(child.lod, childId);
		}

		// 2. Add force-managed root parent nodes
		for (const [rootId, forceNode] of this.forceNodes.entries()) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const threeObj = (forceNode as any).__threeObj;
			if (threeObj) {
				targets.push(threeObj);
				objectToNodeIdMap.set(threeObj, rootId);
			}
		}

		const intersects = raycaster.intersectObjects(targets, true);
		if (intersects.length > 0) {
			for (const hit of intersects) {
				let curr: THREE.Object3D | null = hit.object;
				while (curr) {
					const nodeId = objectToNodeIdMap.get(curr);
					if (nodeId) {
						return nodeId;
					}
					curr = curr.parent;
				}
			}
		}

		return null;
	}

	private setupPointerClickListener(): void {
		if (!this.containerEl || this.isPointerListenerSetup) return;
		this.isPointerListenerSetup = true;

		// Listen for mouse wheel zoom to dynamically adjust camera distance while focused
		this.containerEl.addEventListener('wheel', () => {
			if (this.focusedNodeId && this.graph) {
				const targetPos = this.getNodeWorldPosition(this.focusedNodeId);
				if (targetPos) {
					const camera = this.graph.camera();
					if (camera) {
						this.cameraOffset.set(
							camera.position.x - targetPos.x,
							camera.position.y - targetPos.y,
							camera.position.z - targetPos.z
						);
					}
				}
			}
		}, { passive: true });

		// Prevent browser context menu on graph canvas for clean right clicks
		this.containerEl.addEventListener('contextmenu', (e: MouseEvent) => {
			e.preventDefault();
		});

		this.containerEl.addEventListener('pointerdown', (e: PointerEvent) => {
			this.clickPointerDownPos = { x: e.clientX, y: e.clientY };

			// Right click (button === 2) on empty background space immediately un-focuses camera tracking (click or drag)
			if (e.button === 2) {
				const hitNodeId = this.raycastNodeAtPointer(e);
				if (!hitNodeId) {
					this.clearFocusedNode();
				}
			}
		});

		this.containerEl.addEventListener('pointerup', (e: PointerEvent) => {
			if (!this.clickPointerDownPos || !this.graph) return;

			const isRightClick = e.button === 2;
			const isLeftClick = e.button === 0;

			if (!isLeftClick && !isRightClick) return;

			const dx = e.clientX - this.clickPointerDownPos.x;
			const dy = e.clientY - this.clickPointerDownPos.y;
			const dist = Math.hypot(dx, dy);
			if (dist > 6) return; // Ignore drag operations

			const hitNodeId = this.raycastNodeAtPointer(e);

			if (hitNodeId) {
				if (isRightClick) {
					if (this.onNodeRightClickCallback) {
						this.onNodeRightClickCallback(hitNodeId);
					}
				} else if (isLeftClick) {
					if (this.onNodeClickCallback && !hitNodeId.startsWith('virtual-tag:')) {
						this.onNodeClickCallback(hitNodeId);
					}
				}
			} else {
				if (isRightClick) {
					this.clearFocusedNode();
				}
			}
		});
	}

	/**
	 * Seamlessly update internal settings and reactive 3D scene states
	 * without unmounting or tearing down the Three.js canvas & camera position.
	 */
	updateSettings(newSettings: OrbitPluginSettings): void {
		this.settings = { ...newSettings };
		if (!this.graph) return;

		const isLight = this.settings.theme === 'light';
		const themeColors = THEMES[this.settings.theme] ?? THEMES.celestial;
		const lineHex = isLight ? '#000000' : '#ffffff';

		// 1. Update Graph Canvas Background & 3d-force-graph links
		this.graph.backgroundColor(themeColors.bg);

		const lineStyle = this.settings.lineToParentStyle ?? 'translucent';
		const parentLineOpacity = lineStyle === 'hidden' ? 0 : (lineStyle === 'solid' ? 0.85 : 0.45);
		const linkWidth = lineStyle === 'hidden' ? 0 : (lineStyle === 'solid' ? 1.5 : 0.8);

		this.graph
			.linkColor(() => lineHex)
			.linkWidth(linkWidth)
			.linkOpacity(parentLineOpacity);

		// 2. Update All Force Nodes Size & Theme Colors
		for (const [nodeId, forceNode] of this.forceNodes.entries()) {
			const systemMaxDepth = forceNode.systemMaxDepth;
			const { nodeRadius } = getNodeRelativeSizes(nodeId, forceNode.depth, systemMaxDepth);
			const renderRadius = nodeRadius * BASE_NODE_SCALE * (this.settings.nodeSizeScale ?? 1.0);
			forceNode.renderRadius = renderRadius;

			const newColor = getNodeColor(nodeId, forceNode.depth, this.settings.theme, systemMaxDepth, 0);
			forceNode.color = newColor;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const lodObj = (forceNode as any).__threeObj as THREE.LOD | undefined;
			if (lodObj) {
				this.updateLODObjectScalesAndColors(lodObj, renderRadius, newColor, isLight);
			}
		}

		// 3. Update d3 Repulsion & Cluster Forces dynamically
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const d3 = (window as any).d3;
		if (d3 && typeof d3.forceManyBody === 'function') {
			this.graph.d3Force('charge', d3.forceManyBody().strength(-250 * (this.settings.nodeSizeScale ?? 1.0)));
		}
		this.graph.numDimensions(3);
	}

	/**
	 * Helper to update mesh scale, material colors, and label colors inside an LOD object.
	 */
	private updateLODObjectScalesAndColors(
		lodObj: THREE.LOD,
		renderRadius: number,
		colorHex: string,
		isLight: boolean
	): void {
		const colorObj = new THREE.Color(colorHex);
		const labelHighColor = isLight ? 'rgba(0, 0, 0, 0.90)' : 'rgba(255, 255, 255, 0.90)';

		lodObj.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) {
				const mesh = child as THREE.Mesh;
				if (mesh.scale.x === mesh.scale.y && mesh.scale.y === mesh.scale.z) {
					mesh.scale.setScalar(renderRadius);
				}
				if (mesh.material) {
					const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
					for (const mat of materials) {
						if ('color' in mat && mat.color) {
							(mat as THREE.MeshBasicMaterial).color.copy(colorObj);
						}
						if ('emissive' in mat && mat.emissive) {
							(mat as THREE.MeshLambertMaterial).emissive.copy(colorObj.clone().multiplyScalar(0.15));
						}
					}
				}
			} else if (child instanceof SpriteText) {
				const sprite = child as SpriteText;
				sprite.color = labelHighColor;
				(sprite as unknown as THREE.Object3D).position.y = -(renderRadius * 1.4);
			}
		});
	}

	/**
	 * Initialize or rebuild the 3D graph from a parsed vault graph.
	 */
	initialize(parsedGraph: ParsedGraph): void {
		this.cleanup();
		this.lastTickTime = performance.now();

		// Re-initialize shared geometries if needed
		if (!this.geoHigh) this.geoHigh = new THREE.SphereGeometry(1, 32, 16);
		if (!this.geoMid) this.geoMid = new THREE.SphereGeometry(1, 20, 10);
		if (!this.geoLow) this.geoLow = new THREE.SphereGeometry(1, 12, 6);

		// Compute system max depths (same logic as physics.ts)
		this.computeSystemMaxDepths(parsedGraph);

		// Split nodes into force-managed parents vs orbital children
		const { forceNodeList, forceLinkList } = this.buildForceData(parsedGraph);

		// Build orbital children (flat scene objects with LOD)
		this.buildOrbitalChildren(parsedGraph);

		// Initialize the 3d-force-graph
		// ForceGraph3D is a Kapsule factory: ForceGraph3D()(element)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const factory = ForceGraph3D as any;
		this.graph = factory()(this.containerEl);

		const themeColors = THEMES[this.settings.theme] ?? THEMES.celestial;
		const isLight = this.settings.theme === 'light';
		const lineColorHex = isLight ? '#000000' : '#ffffff';
		const lineStyle = this.settings.lineToParentStyle ?? 'translucent';
		const lineOpacity = lineStyle === 'hidden' ? 0 : (lineStyle === 'solid' ? 0.9 : 0.5);
		const linkWidth = lineStyle === 'hidden' ? 0 : (lineStyle === 'solid' ? 1.5 : 0.8);

		this.graph
			.backgroundColor(themeColors.bg)
			.showNavInfo(false)
			.numDimensions(3)
			.nodeId('id')
			.nodeLabel(() => null) // Disable default HTML tooltip box completely
			.nodeThreeObject((node: object) => this.createParentObject(node as ForceNode))
			.nodeThreeObjectExtend(false)
			.linkColor(() => lineColorHex)
			.linkWidth(linkWidth)
			.linkOpacity(lineOpacity)
			.warmupTicks(50)
			.cooldownTime(5000)
			.onEngineStop(() => this.onEngineStop())
			.graphData({ nodes: forceNodeList, links: forceLinkList });

		// Configure 3D d3 forces for dynamic group clustering & repulsion:
		// 1. Remove link forces (single set of top-level nodes)
		this.graph.d3Force('link', null);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const d3 = (window as any).d3;

		// 2. Node-to-node repulsion force to prevent node overlaps
		if (d3 && typeof d3.forceManyBody === 'function') {
			this.graph.d3Force('charge', d3.forceManyBody().strength(-250 * (this.settings.nodeSizeScale ?? 1.0)));
		} else {
			this.graph.d3Force('charge')?.strength(-250);
		}

		// 3. Center force for overall spatial balance
		if (d3 && typeof d3.forceCenter === 'function') {
			this.graph.d3Force('center', d3.forceCenter(0, 0, 0));
		}

		// 4. Custom 3D Group Positioning Cluster Forces (force('x'), force('y'), force('z'))
		if (d3 && typeof d3.forceX === 'function') {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			this.graph.d3Force('x', d3.forceX((n: any) => n.targetX ?? 0).strength(0.12));
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			this.graph.d3Force('y', d3.forceY((n: any) => n.targetY ?? 0).strength(0.12));
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			this.graph.d3Force('z', d3.forceZ((n: any) => n.targetZ ?? 0).strength(0.12));
		}

		// Add orbital children to the scene
		this.addChildrenToScene();

		// Auto-fit camera 0.1s (100ms) after initiation so DOM layout & WebGL canvas settle
		setTimeout(() => {
			if (this.graph) {
				this.graph.zoomToFit(1000, 100);
			}
		}, 100);

		// Setup raycaster click listener for orbital child nodes
		this.setupPointerClickListener();

		// Start continuous animation loop (runs independently of physics ticks)
		this.startAnimationLoop();
	}



	/**
	 * Clean up all 3D resources.
	 */
	cleanup(): void {
		this.stopAnimationLoop();

		// Remove orbital children from scene
		if (this.graph) {
			const scene = this.graph.scene();
			for (const child of this.orbitalChildren.values()) {
				scene.remove(child.lod);
				child.lod.traverse((obj) => {
					if (obj instanceof THREE.Mesh) {
						if (obj.material instanceof THREE.Material) {
							obj.material.dispose();
						}
					}
				});
			}
		}

		this.orbitalChildren.clear();
		this.forceNodes.clear();
		this.orderedChildIds = [];
		this.systemMaxDepths.clear();
		this.sortedChildrenCache.clear();

		if (this.geoHigh) { this.geoHigh.dispose(); }
		if (this.geoMid) { this.geoMid.dispose(); }
		if (this.geoLow) { this.geoLow.dispose(); }

		if (this.graph) {
			this.graph._destructor();
			this.graph = null;
		}
	}

	/**
	 * Get the underlying ForceGraph3D instance (for external camera/scene access).
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getGraph(): any {
		return this.graph;
	}

	// -----------------------------------------------------------------------
	// Data Preparation
	// -----------------------------------------------------------------------

	/**
	 * Compute system max depths for each root's subtree.
	 */
	private computeSystemMaxDepths(parsedGraph: ParsedGraph): void {
		this.systemMaxDepths.clear();

		for (const rootId of parsedGraph.roots) {
			const subtreeNodes = new Set<string>();
			const queue = [rootId];
			subtreeNodes.add(rootId);

			while (queue.length > 0) {
				const currId = queue.shift()!;
				const currNode = parsedGraph.nodes.get(currId);
				if (currNode) {
					for (const childId of currNode.children) {
						if (!subtreeNodes.has(childId)) {
							subtreeNodes.add(childId);
							queue.push(childId);
						}
					}
				}
			}

			let rootMaxDepth = 0;
			for (const nodeId of subtreeNodes) {
				const node = parsedGraph.nodes.get(nodeId);
				if (node && node.depth > rootMaxDepth) {
					rootMaxDepth = node.depth;
				}
			}

			for (const nodeId of subtreeNodes) {
				const existing = this.systemMaxDepths.get(nodeId) ?? 0;
				this.systemMaxDepths.set(nodeId, Math.max(existing, rootMaxDepth));
			}
		}
	}

	/**
	 * Split ParsedGraph into force-managed parents and identify children.
	 * Parents = root nodes (depth 0, no parents).
	 * Children = everything else.
	 */
	private buildForceData(parsedGraph: ParsedGraph): {
		forceNodeList: ForceNode[];
		forceLinkList: ForceLink[];
	} {
		this.forceNodes.clear();
		const forceNodeList: ForceNode[] = [];
		const forceLinkList: ForceLink[] = []; // No link forces

		// Calculate 3D Target Center Coordinates for each Top-Level Group (Roots)
		const G = Math.max(1, parsedGraph.roots.length);
		const groupTargetMap = new Map<string, THREE.Vector3>();
		const baseRadius = 350 * (this.settings.orbitRadiusScale ?? 1.0);

		for (let i = 0; i < G; i++) {
			const rootId = parsedGraph.roots[i];
			if (!rootId) continue;
			if (G === 1) {
				groupTargetMap.set(rootId, new THREE.Vector3(0, 0, 0));
				continue;
			}
			const theta = i * Math.PI * (3 - Math.sqrt(5)); // Golden angle
			const y = 1 - (i / (G - 1)) * 2;
			const r = Math.sqrt(Math.max(0, 1 - y * y)) * baseRadius;
			groupTargetMap.set(rootId, new THREE.Vector3(
				r * Math.cos(theta),
				y * baseRadius,
				r * Math.sin(theta)
			));
		}

		// Only Top-level Nodes (parents.length === 0 / roots) are subject to 3D Force physics
		for (const rootId of parsedGraph.roots) {
			const node = parsedGraph.nodes.get(rootId);
			if (!node) continue;

			// Filter out lone nodes if hideLoneNodes setting is active
			if (this.settings.hideLoneNodes && node.parents.length === 0 && node.children.length === 0) {
				continue;
			}

			const targetPos = groupTargetMap.get(rootId) ?? new THREE.Vector3(0, 0, 0);
			const systemMaxDepth = this.systemMaxDepths.get(rootId) ?? 0;
			const { nodeRadius } = getNodeRelativeSizes(rootId, node.depth, systemMaxDepth);
			const renderRadius = nodeRadius * BASE_NODE_SCALE * (this.settings.nodeSizeScale ?? 1.0);
			const color = getNodeColor(rootId, node.depth, this.settings.theme, systemMaxDepth, 0);

			const forceNode: ForceNode = {
				id: rootId,
				label: node.label,
				renderRadius,
				color,
				depth: node.depth,
				systemMaxDepth,
				group: rootId,
				targetX: targetPos.x,
				targetY: targetPos.y,
				targetZ: targetPos.z,
			};

			this.forceNodes.set(rootId, forceNode);
			forceNodeList.push(forceNode);
		}

		return { forceNodeList, forceLinkList };
	}

	/**
	 * Create orbital child metadata and Three.js objects for all non-root nodes.
	 */
	private buildOrbitalChildren(parsedGraph: ParsedGraph): void {
		this.orbitalChildren.clear();
		this.sortedChildrenCache.clear();
		const childEntries: { id: string; depth: number }[] = [];

		// BFS from roots to initialize orbital children in depth order
		const queue = [...parsedGraph.roots];
		const visited = new Set<string>(parsedGraph.roots);

		while (queue.length > 0) {
			const parentId = queue.shift()!;
			const parentNode = parsedGraph.nodes.get(parentId);
			if (!parentNode) continue;

			// Sort children by sibling sort mode
			const sortedChildren = this.sortSiblings(parentNode.children, parsedGraph);
			this.sortedChildrenCache.set(parentId, sortedChildren);

			for (let i = 0; i < sortedChildren.length; i++) {
				const childId = sortedChildren[i]!;
				if (visited.has(childId)) continue;
				visited.add(childId);

				const childNode = parsedGraph.nodes.get(childId);
				if (!childNode) continue;

				const systemMaxDepth = this.systemMaxDepths.get(childId) ?? 0;
				const { nodeRadius: childRelNode, orbitRadius: childRelOrbit } =
					getNodeRelativeSizes(childId, childNode.depth, systemMaxDepth);

				let radius = childRelOrbit * BASE_ORBIT_SCALE * this.settings.orbitRadiusScale;
				const N = sortedChildren.length;
				if (N > 1) {
					const scale = 0.5 + 1.0 * (i / (N - 1));
					radius *= scale;
				}

				// Angular velocity (Kepler-inspired)
				let direction = 1;
				if (this.settings.orbitDirection === 'clockwise') {
					direction = 1;
				} else if (this.settings.orbitDirection === 'counterclockwise') {
					direction = -1;
				} else {
					direction = childNode.depth % 2 === 0 ? 1 : -1;
				}
				const baseOmega = this.settings.keplerBaseOmega >= 0
					? this.settings.keplerBaseOmega : 5;
				const omega = (radius > 0 ? (baseOmega / Math.sqrt(radius)) : 0) * direction;

				const theta = Math.random() * Math.PI * 2;
				const renderRadius = childRelNode * BASE_NODE_SCALE * this.settings.nodeSizeScale;
				const color = getNodeColor(childId, childNode.depth, this.settings.theme, systemMaxDepth, i);
				const colorObj = new THREE.Color(color);

				// Create THREE.LOD for variable resolution
				const lod = new THREE.LOD();

				const matHigh = new THREE.MeshLambertMaterial({
					color: colorObj,
					emissive: colorObj.clone().multiplyScalar(0.15),
					transparent: true,
				});
				const matMid = new THREE.MeshLambertMaterial({
					color: colorObj,
					emissive: colorObj.clone().multiplyScalar(0.1),
					transparent: true,
				});
				const matLow = new THREE.MeshBasicMaterial({
					color: colorObj,
					transparent: true,
				});

				// Level 0: High-Poly (0 ~ 400 distance) -> Mesh + Label
				const highGroup = new THREE.Group();
				const highMesh = new THREE.Mesh(this.geoHigh, matHigh);
				highMesh.scale.setScalar(renderRadius);
				highMesh.renderOrder = 1;
				highGroup.add(highMesh);

				const isLight = this.settings.theme === 'light';
				const colorHigh = isLight ? 'rgba(0, 0, 0, 0.90)' : 'rgba(255, 255, 255, 0.90)';
				const colorMid = isLight ? 'rgba(0, 0, 0, 0.65)' : 'rgba(255, 255, 255, 0.65)';

				const labelHigh = new SpriteText(childNode.label, renderRadius * 0.8, colorHigh);
				labelHigh.fontFace = 'Inter, system-ui, sans-serif';
				labelHigh.backgroundColor = false;
				labelHigh.borderColor = 'transparent';
				labelHigh.borderWidth = 0;
				labelHigh.strokeWidth = 0;
				labelHigh.strokeColor = 'transparent';
				labelHigh.padding = 0;
				(labelHigh as unknown as THREE.Object3D).position.y = -(renderRadius * 1.4);
				highGroup.add(labelHigh as unknown as THREE.Object3D);

				lod.addLevel(highGroup, 0);

				// Level 1: Mid-Poly (1000 ~ 1500 distance) -> Mid Mesh + Faded Label
				const midGroup = new THREE.Group();
				const midMesh = new THREE.Mesh(this.geoMid, matMid);
				midMesh.scale.setScalar(renderRadius);
				midMesh.renderOrder = 1;
				midGroup.add(midMesh);

				const labelMid = new SpriteText(childNode.label, renderRadius * 0.8, colorMid);
				labelMid.fontFace = 'Inter, system-ui, sans-serif';
				labelMid.backgroundColor = false;
				labelMid.borderColor = 'transparent';
				labelMid.borderWidth = 0;
				labelMid.strokeWidth = 0;
				labelMid.strokeColor = 'transparent';
				labelMid.padding = 0;
				(labelMid as unknown as THREE.Object3D).position.y = -(renderRadius * 1.4);
				midGroup.add(labelMid as unknown as THREE.Object3D);

				lod.addLevel(midGroup, 1000);

				// Level 2: Low-Poly (1500 ~ 2000 distance) -> Low Mesh only
				const lowMesh = new THREE.Mesh(this.geoLow, matLow);
				lowMesh.scale.setScalar(renderRadius);
				lowMesh.renderOrder = 1;

				lod.addLevel(lowMesh, 1500);

				// [Test] Add level text sprite on top of the node (Commented out)
				// const levelSprite = new SpriteText('Level 0', renderRadius * 1.2, '#FFE600');
				// levelSprite.fontFace = 'Inter, system-ui, sans-serif';
				// levelSprite.fontWeight = 'bold';
				// levelSprite.backgroundColor = 'rgba(0, 0, 0, 0.7)';
				// levelSprite.padding = 2;
				// levelSprite.borderRadius = 3;
				// (levelSprite as unknown as THREE.Object3D).position.y = renderRadius * 2.0;
				// lod.add(levelSprite as unknown as THREE.Object3D);
				// (lod as any).__levelSprite = levelSprite;

				// Create 3D Orbit Trace circle line
				const lineHex = isLight ? '#000000' : '#ffffff';

				const traceStyle = this.settings.orbitTraceStyle ?? 'translucent';
				const traceVisible = traceStyle !== 'hidden' && radius > 0;
				const traceOpacity = traceStyle === 'solid' ? 0.85 : 0.45;

				let orbitTraceObj: THREE.LineLoop | undefined;
				if (radius > 0) {
					const pts: THREE.Vector3[] = [];
					const segs = 64;
					for (let k = 0; k < segs; k++) {
						const a = (k / segs) * Math.PI * 2;
						pts.push(new THREE.Vector3(radius * Math.cos(a), 0, radius * Math.sin(a)));
					}
					const traceGeo = new THREE.BufferGeometry().setFromPoints(pts);
					const traceMat = new THREE.LineBasicMaterial({
						color: new THREE.Color(lineHex),
						transparent: true,
						opacity: traceOpacity,
						depthWrite: false,
					});
					orbitTraceObj = new THREE.LineLoop(traceGeo, traceMat);
					orbitTraceObj.visible = traceVisible;
				}

				// Create 3D Parent-Child Connection lines
				const parentStyle = this.settings.lineToParentStyle ?? 'translucent';
				const parentLineVisible = parentStyle !== 'hidden';
				const parentLineOpacity = parentStyle === 'solid' ? 0.85 : 0.45;
				const parentLineObjs: THREE.Line[] = [];

				for (let pIdx = 0; pIdx < childNode.parents.length; pIdx++) {
					const pGeo = new THREE.BufferGeometry().setFromPoints([
						new THREE.Vector3(0, 0, 0),
						new THREE.Vector3(0, 0, 0),
					]);
					const pMat = new THREE.LineBasicMaterial({
						color: new THREE.Color(lineHex),
						transparent: true,
						opacity: parentLineOpacity,
						depthWrite: false,
					});
					const pLine = new THREE.Line(pGeo, pMat);
					pLine.visible = parentLineVisible;
					parentLineObjs.push(pLine);
				}

				const orbitalChild: OrbitalChild = {
					id: childId,
					label: childNode.label,
					parentIds: [...childNode.parents],
					depth: childNode.depth,
					theta,
					omega,
					orbitRadius: radius,
					renderRadius,
					siblingIndex: i,
					systemMaxDepth,
					color,
					lod,
					orbitTraceObj,
					parentLineObjs,
				};

				this.orbitalChildren.set(childId, orbitalChild);
				childEntries.push({ id: childId, depth: childNode.depth });
				queue.push(childId);
			}
		}

		// Order by depth ascending so parents are computed before children
		childEntries.sort((a, b) => a.depth - b.depth);
		this.orderedChildIds = childEntries.map((e) => e.id);
	}

	/**
	 * Sort sibling node IDs based on the active sort mode (ported from physics.ts).
	 */
	private sortSiblings(childIds: string[], graph: ParsedGraph): string[] {
		const sorted = [...childIds];
		sorted.sort((a, b) => {
			const na = graph.nodes.get(a);
			const nb = graph.nodes.get(b);
			if (!na || !nb) return 0;

			switch (this.settings.siblingSortMode) {
				case 'fileSize':
					return nb.fileSize - na.fileSize;
				case 'createdTime':
					return na.createdTime - nb.createdTime;
				case 'modifiedTime':
					return nb.modifiedTime - na.modifiedTime;
				case 'alphabetical':
					return na.label.localeCompare(nb.label);
				default:
					return 0;
			}
		});
		return sorted;
	}

	// -----------------------------------------------------------------------
	// Three.js Object Creation
	// -----------------------------------------------------------------------

	/**
	 * Create the Three.js visual for a force-managed parent node using THREE.LOD.
	 */
	private createParentObject(node: ForceNode): THREE.Object3D {
		const lod = new THREE.LOD();
		const colorObj = new THREE.Color(node.color);

		const matHigh = new THREE.MeshLambertMaterial({
			color: colorObj,
			emissive: colorObj.clone().multiplyScalar(0.2),
			transparent: true,
		});
		const matMid = new THREE.MeshLambertMaterial({
			color: colorObj,
			emissive: colorObj.clone().multiplyScalar(0.15),
			transparent: true,
		});
		const matLow = new THREE.MeshBasicMaterial({
			color: colorObj,
			transparent: true,
		});

		// Level 0: High-Poly Group (Distance < 400)
		const highGroup = new THREE.Group();
		const highMesh = new THREE.Mesh(this.geoHigh, matHigh);
		highMesh.scale.setScalar(node.renderRadius);
		highGroup.add(highMesh);

		const glowMaterial = new THREE.MeshBasicMaterial({
			color: colorObj,
			transparent: true,
			opacity: 0.12,
			depthWrite: false,
		});
		const glowMesh = new THREE.Mesh(this.geoMid, glowMaterial);
		glowMesh.scale.setScalar(node.renderRadius * 1.6);
		highGroup.add(glowMesh);

		const isLight = this.settings.theme === 'light';
		const colorHigh = isLight ? 'rgba(0, 0, 0, 0.90)' : 'rgba(255, 255, 255, 0.90)';
		const colorMid = isLight ? 'rgba(0, 0, 0, 0.65)' : 'rgba(255, 255, 255, 0.65)';

		const labelHigh = new SpriteText(node.label, node.renderRadius * 0.7, colorHigh);
		labelHigh.fontFace = 'Inter, system-ui, sans-serif';
		labelHigh.backgroundColor = false;
		labelHigh.borderColor = 'transparent';
		labelHigh.borderWidth = 0;
		labelHigh.strokeWidth = 0;
		labelHigh.strokeColor = 'transparent';
		labelHigh.padding = 0;
		(labelHigh as unknown as THREE.Object3D).position.y = -(node.renderRadius * 1.5);
		highGroup.add(labelHigh as unknown as THREE.Object3D);

		lod.addLevel(highGroup, 0);

		// Level 1: Mid-Poly Group (Distance 1000 ~ 1500)
		const midGroup = new THREE.Group();
		const midMesh = new THREE.Mesh(this.geoMid, matMid);
		midMesh.scale.setScalar(node.renderRadius);
		midGroup.add(midMesh);

		const labelMid = new SpriteText(node.label, node.renderRadius * 0.7, colorMid);
		labelMid.fontFace = 'Inter, system-ui, sans-serif';
		labelMid.backgroundColor = false;
		labelMid.borderColor = 'transparent';
		labelMid.borderWidth = 0;
		labelMid.strokeWidth = 0;
		labelMid.strokeColor = 'transparent';
		labelMid.padding = 0;
		(labelMid as unknown as THREE.Object3D).position.y = -(node.renderRadius * 1.5);
		midGroup.add(labelMid as unknown as THREE.Object3D);

		lod.addLevel(midGroup, 1000);

		// Level 2: Low-Poly Mesh (Distance 1500 ~ 2000)
		const lowMesh = new THREE.Mesh(this.geoLow, matLow);
		lowMesh.scale.setScalar(node.renderRadius);

		lod.addLevel(lowMesh, 1500);

		// [Test] Add level text sprite on top of the node (Commented out)
		// const levelSprite = new SpriteText('Level 0', node.renderRadius * 1.2, '#FFE600');
		// levelSprite.fontFace = 'Inter, system-ui, sans-serif';
		// levelSprite.fontWeight = 'bold';
		// levelSprite.backgroundColor = 'rgba(0, 0, 0, 0.7)';
		// levelSprite.padding = 2;
		// levelSprite.borderRadius = 3;
		// (levelSprite as unknown as THREE.Object3D).position.y = node.renderRadius * 2.0;
		// lod.add(levelSprite as unknown as THREE.Object3D);
		// (lod as any).__levelSprite = levelSprite;

		return lod;
	}

	/**
	 * Add all orbital children to the 3d-force-graph scene.
	 */
	private addChildrenToScene(): void {
		if (!this.graph) return;
		const scene = this.graph.scene();

		for (const child of this.orbitalChildren.values()) {
			scene.add(child.lod);
			if (child.orbitTraceObj) {
				scene.add(child.orbitTraceObj);
			}
			if (child.parentLineObjs) {
				for (const pLine of child.parentLineObjs) {
					scene.add(pLine);
				}
			}
		}
	}

	// -----------------------------------------------------------------------
	// Continuous Animation Loop (Independent of Physics Engine Ticks)
	// -----------------------------------------------------------------------

	/**
	 * Start a continuous requestAnimationFrame loop for perpetual orbital motion.
	 */
	private startAnimationLoop(): void {
		this.stopAnimationLoop();
		this.lastTickTime = performance.now();

		const animate = () => {
			this.updateOrbitalAnimation();
			this.animFrameId = requestAnimationFrame(animate);
		};
		this.animFrameId = requestAnimationFrame(animate);
	}

	/**
	 * Stop the continuous requestAnimationFrame loop.
	 */
	private stopAnimationLoop(): void {
		if (this.animFrameId !== null) {
			cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}
	}

	/**
	 * Runs on every animation frame (60 FPS).
	 * Computes world positions for all orbital children via math equations,
	 * and updates LOD levels relative to the camera.
	 */
	private updateOrbitalAnimation(): void {
		const now = performance.now();
		const dt = Math.min((now - this.lastTickTime) / 1000, 0.1);
		this.lastTickTime = now;

		// 1. Advance orbital angles & compute world positions for child nodes
		for (const child of this.orbitalChildren.values()) {
			child.theta += child.omega * dt;
		}
		for (const childId of this.orderedChildIds) {
			this.updateChildWorldPosition(childId);
		}

		// 2. Update Level of Detail (LOD) and distance-based opacity/culling
		if (this.graph) {
			const camera = this.graph.camera();
			if (camera) {
				const cameraPos = camera.position;
				const tempPos = new THREE.Vector3();

				// Update LOD & Opacity for top-level 3D force nodes
				for (const forceNode of this.forceNodes.values()) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const lodObj = (forceNode as any).__threeObj;
					if (lodObj) {
						if (lodObj.isLOD) {
							lodObj.update(camera);
						}
						lodObj.getWorldPosition(tempPos);
						const dist = cameraPos.distanceTo(tempPos);
						this.updateNodeDistanceOpacity(lodObj, dist);
					}
				}

				// Update LOD & Opacity for flat orbital child nodes
				for (const child of this.orbitalChildren.values()) {
					child.lod.update(camera);
					const dist = cameraPos.distanceTo(child.lod.position);
					this.updateNodeDistanceOpacity(child.lod, dist);
				}

				// 3. Realtime Camera Tracking/Following for Focused Orbiting Node
				if (this.focusedNodeId) {
					const targetPos = this.getNodeWorldPosition(this.focusedNodeId);
					if (targetPos) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const controls = (this.graph as any).controls?.();
						if (controls && controls.state !== undefined && controls.state !== -1) {
							this.cameraOffset.set(
								cameraPos.x - targetPos.x,
								cameraPos.y - targetPos.y,
								cameraPos.z - targetPos.z
							);
						}

						const camX = targetPos.x + this.cameraOffset.x;
						const camY = targetPos.y + this.cameraOffset.y;
						const camZ = targetPos.z + this.cameraOffset.z;

						this.graph.cameraPosition(
							{ x: camX, y: camY, z: camZ },
							{ x: targetPos.x, y: targetPos.y, z: targetPos.z },
							0
						);
					}
				}
			}
		}
	}

	/*
	Level 0 (거리 0 - 1000 미만)
	Level 1 (거리 1000 - 1500 미만)
	Level 2 (거리 1500 - 2000 미만)
	Level 3 (거리 2000 - 52000 미만: 거리 500당 투명도 1% 증가)
	Level 4 (거리 52000 이상: 렌더링 안함)
	*/

	/**
	 * Apply distance-based opacity and culling rules:
	 * - Level 0 ~ 2 (Distance < 2000): Transparency 0% (Opacity 1.0)
	 * - Level 3 (Distance 2000 ~ 52000): Transparency increases by 1% per 500 distance (Opacity = 1.0 - (distance - 2000) / 50000)
	 * - Level 4 (Distance >= 52000): Do not render (visible = false)
	 */
	private updateNodeDistanceOpacity(nodeObj: THREE.Object3D, distance: number): void {
		let level = 0;
		if (distance < 1000) {
			level = 0;
		} else if (distance < 1500) {
			level = 1;
		} else if (distance < 2000) {
			level = 2;
		} else if (distance < 52000) {
			level = 3;
		} else {
			level = 4;
		}

		// [Test] Update level number displayed on top of node (Commented out)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		// const levelSprite = (nodeObj as any).__levelSprite;
		// if (levelSprite) {
		// 	levelSprite.text = `Level ${level}`;
		// }

		if (distance >= 52000) {
			nodeObj.visible = false;
			return;
		}
		nodeObj.visible = true;

		if (distance < 2000) {
			this.setObjectOpacity(nodeObj, 1.0);
		} else {
			// Level 3 (Distance 2000 ~ 52000): Transparency increases by 1% per 500 distance
			const alphaMult = Math.max(0, 1.0 - (distance - 2000) / 50000);
			this.setObjectOpacity(nodeObj, alphaMult);
		}
	}

	/**
	 * Multiplies base opacity of all materials inside a Three.js Object3D by alphaMult.
	 */
	private setObjectOpacity(obj: THREE.Object3D, alphaMult: number): void {
		obj.traverse((child) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const anyChild = child as any;
			if (anyChild.material) {
				const materials = Array.isArray(anyChild.material) ? anyChild.material : [anyChild.material];
				for (const mat of materials) {
					mat.transparent = true;
					if (mat.userData.baseOpacity === undefined) {
						mat.userData.baseOpacity = mat.opacity ?? 1.0;
					}
					mat.opacity = mat.userData.baseOpacity * alphaMult;
				}
			}
		});
	}

	/**
	 * Compute absolute 3D world position and realtime orbit/connection lines for an orbital child:
	 * - N=1 (Single Parent): Circular orbit parallel to XY plane around parent P(x, y, z).
	 * - N=2 (Dual Parent): 3D Elliptical orbit with parents P1 & P2 as Foci in 3D space (when dualParentOvalOrbit enabled).
	 * - N>=3 (Multi Parent): Circular orbit centered at Center of Mass (Centroid) of all parents.
	 * - Realtime dynamic updates of Orbit Path LineLoop & Parent-Child Connection Lines per frame.
	 */
	private updateChildWorldPosition(childId: string): void {
		const child = this.orbitalChildren.get(childId);
		if (!child) return;

		const parentPositions = this.getParentWorldPositions(child.parentIds);
		if (parentPositions.length === 0) return;

		const numParents = parentPositions.length;
		let x = 0, y = 0, z = 0;
		const tracePoints: THREE.Vector3[] = [];
		const segs = 64;

		if (numParents === 1) {
			// N=1: Circular orbit parallel to XY plane around single parent P(x, y, z)
			const p = parentPositions[0]!;
			const r = child.orbitRadius;
			x = p.x + r * Math.cos(child.theta);
			y = p.y + r * Math.sin(child.theta);
			z = p.z; // Parallel to XY plane

			// Realtime 3D Orbit Path Points for N=1
			if (child.orbitTraceObj) {
				for (let k = 0; k < segs; k++) {
					const angle = (k / segs) * Math.PI * 2;
					tracePoints.push(new THREE.Vector3(p.x + r * Math.cos(angle), p.y + r * Math.sin(angle), p.z));
				}
			}
		} else if (numParents === 2 && (this.settings.dualParentOvalOrbit ?? true)) {
			// N=2: 3D Elliptical Orbit with 2 Foci (Parents P1 & P2 in 3D Space)
			const p1 = parentPositions[0]!;
			const p2 = parentPositions[1]!;

			const cx = (p1.x + p2.x) / 2;
			const cy = (p1.y + p2.y) / 2;
			const cz = (p1.z + p2.z) / 2;

			const dx = p2.x - p1.x;
			const dy = p2.y - p1.y;
			const dz = p2.z - p1.z;
			const d = Math.sqrt(dx * dx + dy * dy + dz * dz);

			const u = new THREE.Vector3(1, 0, 0);
			if (d > 0.0001) {
				u.set(dx / d, dy / d, dz / d);
			}

			// Perpendicular vector v to u in 3D space
			const ref = Math.abs(u.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
			const v = new THREE.Vector3().crossVectors(u, ref).normalize();

			const a = d / 2 + child.orbitRadius; // Semi-major axis
			const b = a * 0.65;                  // Semi-minor axis

			const xLocal = a * Math.cos(child.theta);
			const yLocal = b * Math.sin(child.theta);

			// 3D Position: Center + xLocal * u + yLocal * v
			x = cx + xLocal * u.x + yLocal * v.x;
			y = cy + xLocal * u.y + yLocal * v.y;
			z = cz + xLocal * u.z + yLocal * v.z;

			// Realtime 3D Elliptical Orbit Path Points for N=2
			if (child.orbitTraceObj) {
				for (let k = 0; k < segs; k++) {
					const angle = (k / segs) * Math.PI * 2;
					const xl = a * Math.cos(angle);
					const yl = b * Math.sin(angle);
					tracePoints.push(new THREE.Vector3(
						cx + xl * u.x + yl * v.x,
						cy + xl * u.y + yl * v.y,
						cz + xl * u.z + yl * v.z
					));
				}
			}
		} else {
			// N>=3 (or N=2 circular fallback): Centroid Orbit at Center of Mass
			let sumX = 0, sumY = 0, sumZ = 0;
			for (const p of parentPositions) {
				sumX += p.x;
				sumY += p.y;
				sumZ += p.z;
			}
			const cx = sumX / numParents;
			const cy = sumY / numParents;
			const cz = sumZ / numParents;

			let maxDist = 0;
			for (const p of parentPositions) {
				const dist = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
				if (dist > maxDist) maxDist = dist;
			}

			const orbitR = maxDist + child.orbitRadius;
			x = cx + orbitR * Math.cos(child.theta);
			y = cy + orbitR * Math.sin(child.theta);
			z = cz;

			// Realtime 3D Orbit Path Points for N>=3
			if (child.orbitTraceObj) {
				for (let k = 0; k < segs; k++) {
					const angle = (k / segs) * Math.PI * 2;
					tracePoints.push(new THREE.Vector3(
						cx + orbitR * Math.cos(angle),
						cy + orbitR * Math.sin(angle),
						cz
					));
				}
			}
		}

		// Set LOD object world position
		child.lod.position.set(x, y, z);

		// Realtime Update 3D Orbit Trace Path Geometry
		if (child.orbitTraceObj && tracePoints.length > 0) {
			child.orbitTraceObj.position.set(0, 0, 0); // Set to absolute origin since points are in world space
			child.orbitTraceObj.geometry.setFromPoints(tracePoints);
			(child.orbitTraceObj.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
		}

		// Realtime Update 3D Parent-Child Connection Lines
		if (child.parentLineObjs) {
			for (let pIdx = 0; pIdx < parentPositions.length; pIdx++) {
				const pLine = child.parentLineObjs[pIdx];
				const pPos = parentPositions[pIdx];
				if (pLine && pPos) {
					const posAttr = pLine.geometry.attributes.position as THREE.BufferAttribute;
					if (posAttr) {
						posAttr.setXYZ(0, pPos.x, pPos.y, pPos.z);
						posAttr.setXYZ(1, x, y, z);
						posAttr.needsUpdate = true;
					}
				}
			}
		}
	}

	/**
	 * Resolve parent world positions from either force nodes or orbital children.
	 */
	private getParentWorldPositions(
		parentIds: string[]
	): { x: number; y: number; z: number }[] {
		const positions: { x: number; y: number; z: number }[] = [];

		for (const pid of parentIds) {
			// Check force-managed parents first
			const forceNode = this.forceNodes.get(pid);
			if (forceNode && forceNode.x !== undefined && forceNode.y !== undefined) {
				positions.push({
					x: forceNode.x,
					y: forceNode.y,
					z: forceNode.z ?? 0,
				});
				continue;
			}

			// Check orbital children (recursive case)
			const orbChild = this.orbitalChildren.get(pid);
			if (orbChild) {
				positions.push({
					x: orbChild.lod.position.x,
					y: orbChild.lod.position.y,
					z: orbChild.lod.position.z,
				});
			}
		}

		return positions;
	}

	// -----------------------------------------------------------------------
	// Engine Events
	// -----------------------------------------------------------------------

	/**
	 * Called when the force engine stops (layout stabilized).
	 */
	private onEngineStop(): void {
		// Do not force camera zoomToFit on engine stop to preserve user's camera positioning
	}
}
