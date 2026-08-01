import * as THREE from 'three';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ForceGraph3D from '3d-force-graph';
import type { ParsedGraph, OrbitPluginSettings } from '../types';
import type { Graph3DContext, ForceNode, OrbitalChild, ForceLink } from './types';
import { NodeFocusedCameraControls } from './NodeFocusedCameraControls';
import { InteractionHandler } from './InteractionHandler';
import { OrbitalMechanics } from './OrbitalMechanics';
import {
	BASE_NODE_SCALE,
	createGalacticCoreObject,
	createParentObject,
	updateLODObjectScalesAndColors,
	updateNodeDistanceOpacity,
	getNodeRelativeSizes
} from './SceneBuilder';
import { THEMES, getNodeColor } from '../renderer';

export class GalaxyCustomManager implements Graph3DContext {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private graph: any = null;
	private containerEl: HTMLElement;
	private settings: OrbitPluginSettings;

	private forceNodes: Map<string, ForceNode> = new Map();
	private orbitalChildren: Map<string, OrbitalChild> = new Map();
	
	public galacticCoreObj: THREE.Group | null = null;
	private orderedChildIds: string[] = [];
	private systemMaxDepths: Map<string, number> = new Map();
	private sortedChildrenCache: Map<string, string[]> = new Map();

	public geoHighest: THREE.SphereGeometry = new THREE.SphereGeometry(1, 32, 16);
	public geoHigh: THREE.SphereGeometry = new THREE.SphereGeometry(1, 24, 12);
	public geoMid: THREE.SphereGeometry = new THREE.SphereGeometry(1, 16, 8);
	public geoLow: THREE.SphereGeometry = new THREE.SphereGeometry(1, 12, 6);

	private animFrameId: number | null = null;
	private lastTickTime: number = 0;
	private isEngineRunning: boolean = true;

	public isNodeDragging: boolean = false;
	public onNodeClickCallback: ((nodeId: string) => void) | null = null;
	public onNodeRightClickCallback: ((nodeId: string) => void) | null = null;
	public clickPointerDownPos: { x: number; y: number } | null = null;

	public pendingRmbTargetNodeId: string | null = null;
	public pendingRmbDownPos: { x: number; y: number } | null = null;
	public isRmbDragging: boolean = false;

	public pendingMmbDownPos: { x: number; y: number } | null = null;
	public isMmbDragging: boolean = false;
	public isLmbDragging: boolean = false;

	private focusedNodeId: string | null = null;
	private cameraOffset: THREE.Vector3 = new THREE.Vector3(0, 0, 400);
	public onFocusChangeCallback: ((nodeId: string | null) => void) | null = null;

	private cameraControls: NodeFocusedCameraControls;
	private interactionHandler: InteractionHandler;
	private orbitalMechanics: OrbitalMechanics;

	constructor(containerEl: HTMLElement, settings: OrbitPluginSettings) {
		this.containerEl = containerEl;
		this.settings = settings;

		this.cameraControls = new NodeFocusedCameraControls(this);
		this.interactionHandler = new InteractionHandler(this, this.cameraControls);
		this.orbitalMechanics = new OrbitalMechanics(this);
	}

	// ---------------------------------------------------------------------------
	// Context Implementation
	// ---------------------------------------------------------------------------
	getGraph() { return this.graph; }
	getSettings() { return this.settings; }
	getForceNodes() { return this.forceNodes; }
	getOrbitalChildren() { return this.orbitalChildren; }
	getSystemMaxDepths() { return this.systemMaxDepths; }
	getSortedChildrenCache() { return this.sortedChildrenCache; }
	getOrderedChildIds() { return this.orderedChildIds; }
	setOrderedChildIds(ids: string[]) { this.orderedChildIds = ids; }
	public getFocusedNodeId(): string | null { return this.focusedNodeId; }
	setFocusedNodeId(id: string | null) { this.focusedNodeId = id; }
	getCameraOffset() { return this.cameraOffset; }
	setGalacticCoreObj(obj: THREE.Group | null) { this.galacticCoreObj = obj; }

	// ---------------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------------
	getNodeWorldPosition(nodeId: string): { x: number; y: number; z: number } | null {
		const tempPos = new THREE.Vector3();
		const forceNode = this.forceNodes.get(nodeId);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const forceObj = forceNode ? (forceNode as any).__threeObj : null;
		if (forceObj && typeof forceObj.getWorldPosition === 'function') {
			forceObj.getWorldPosition(tempPos);
			return { x: tempPos.x, y: tempPos.y, z: tempPos.z };
		}
		if (forceNode && forceNode.x !== undefined && forceNode.y !== undefined) {
			return { x: forceNode.x, y: forceNode.y, z: forceNode.z ?? 0 };
		}
		const orbChild = this.orbitalChildren.get(nodeId);
		if (orbChild && orbChild.lod && typeof orbChild.lod.getWorldPosition === 'function') {
			orbChild.lod.getWorldPosition(tempPos);
			return { x: tempPos.x, y: tempPos.y, z: tempPos.z };
		}
		return null;
	}

	getNodeLocalPosition(nodeId: string): { x: number; y: number; z: number } | null {
		const forceNode = this.forceNodes.get(nodeId);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const forceObj = forceNode ? (forceNode as any).__threeObj : null;
		if (forceObj && forceObj.position) {
			return { x: forceObj.position.x, y: forceObj.position.y, z: forceObj.position.z };
		}
		if (forceNode && forceNode.x !== undefined && forceNode.y !== undefined) {
			return { x: forceNode.x, y: forceNode.y, z: forceNode.z ?? 0 };
		}

		const orbChild = this.orbitalChildren.get(nodeId);
		if (orbChild && orbChild.lod && orbChild.lod.position) {
			return { x: orbChild.lod.position.x, y: orbChild.lod.position.y, z: orbChild.lod.position.z };
		}

		return null;
	}

	setOnFocusChange(callback: (nodeId: string | null) => void): void {
		this.onFocusChangeCallback = callback;
	}

	setFocusedNode(nodeId: string | null): void {
		this.cameraControls.setFocusedNode(nodeId);
	}

	clearFocusedNode(): void {
		this.cameraControls.clearFocusedNode();
	}

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

	setOnNodeRightClick(callback: (nodeId: string) => void): void {
		this.onNodeRightClickCallback = callback;
		if (this.graph) {
			this.graph.onNodeRightClick((node: object) => {
				const n = node as { id?: string };
				if (n.id && !n.id.startsWith('virtual-tag:')) {
					callback(n.id);
				}
			});
		}
	}

	raycastNodeAtPointer(e: PointerEvent): string | null {
		return this.interactionHandler.raycastNodeAtPointer(e);
	}

	updateSettings(newSettings: OrbitPluginSettings): void {
		this.settings = { ...newSettings };
		if (!this.graph) return;

		const isLight = this.settings.theme === 'light';
		const themeColors = THEMES[this.settings.theme] ?? THEMES.celestial;
		const lineHex = isLight ? '#000000' : '#ffffff';

		this.graph.backgroundColor(themeColors.bg);

		const lineStyle = this.settings.lineToParentStyle ?? 'translucent';
		const parentLineOpacity = lineStyle === 'hidden' ? 0 : (lineStyle === 'solid' ? 0.85 : 0.45);
		const linkWidth = lineStyle === 'hidden' ? 0 : (lineStyle === 'solid' ? 1.5 : 0.8);

		this.graph
			.linkColor(() => lineHex)
			.linkWidth(linkWidth)
			.linkOpacity(parentLineOpacity);

		// Manually update existing 3d-force-graph link materials dynamically
		this.graph.scene().traverse((obj: THREE.Object3D) => {
			if (obj.type === 'Line' || obj.type === 'LineSegments') {
				// Exclude AxesHelper
				if (obj.constructor.name === 'AxesHelper') return;
				if (obj.parent && obj.parent.constructor.name === 'AxesHelper') return;

				const lineObj = obj as THREE.Line;
				if (lineObj.material && (lineObj.material as THREE.Material).type === 'LineBasicMaterial') {
					const mat = lineObj.material as THREE.LineBasicMaterial;
					mat.color.set(lineHex);
					mat.opacity = parentLineOpacity;
					mat.transparent = parentLineOpacity < 1.0;
					mat.needsUpdate = true;
				}
			}
		});

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
				updateLODObjectScalesAndColors(lodObj, renderRadius, newColor, isLight);
			}
		}

		const traceStyle = this.settings.orbitTraceStyle ?? 'translucent';
		const traceVisible = traceStyle !== 'hidden';
		const traceOpacity = traceStyle === 'solid' ? 0.85 : 0.45;
		const parentLineVisible = lineStyle !== 'hidden';

		for (const child of this.orbitalChildren.values()) {
			const { nodeRadius } = getNodeRelativeSizes(child.id, child.depth, child.systemMaxDepth);
			const renderRadius = nodeRadius * BASE_NODE_SCALE * (this.settings.nodeSizeScale ?? 1.0);
			child.renderRadius = renderRadius;
			
			const newColor = getNodeColor(child.id, child.depth, this.settings.theme, child.systemMaxDepth, child.siblingIndex);
			child.color = newColor;

			if (child.lod) {
				updateLODObjectScalesAndColors(child.lod, renderRadius, newColor, isLight);
			}

			if (child.orbitTraceObj) {
				child.orbitTraceObj.visible = traceVisible && child.orbitRadius > 0;
				if (child.orbitTraceObj.material instanceof THREE.ShaderMaterial) {
					const mat = child.orbitTraceObj.material;
					if (mat.uniforms && mat.uniforms.uColor) mat.uniforms.uColor.value.set(lineHex);
					if (mat.uniforms && mat.uniforms.uOpacity) mat.uniforms.uOpacity.value = traceOpacity;
				}
			}
			if (child.parentLineObjs) {
				for (const pLine of child.parentLineObjs) {
					pLine.visible = parentLineVisible;
					if (pLine.material instanceof THREE.ShaderMaterial) {
						const mat = pLine.material;
						if (mat.uniforms && mat.uniforms.uColor) mat.uniforms.uColor.value.set(lineHex);
						if (mat.uniforms && mat.uniforms.uOpacity) mat.uniforms.uOpacity.value = parentLineOpacity;
					}
				}
			}
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const d3 = (window as any).d3;
		if (d3 && typeof d3.forceManyBody === 'function') {
			this.graph.d3Force('charge', d3.forceManyBody().strength(-250 * (this.settings.nodeSizeScale ?? 1.0)));
		}
		
		if (this.galacticCoreObj) {
			this.galacticCoreObj.visible = this.settings.showAxis ?? false;
		}
	}

	initialize(parsedGraph: ParsedGraph): void {
		this.cleanup();
		this.lastTickTime = performance.now();

		if (!this.geoHigh) this.geoHigh = new THREE.SphereGeometry(1, 32, 16);
		if (!this.geoMid) this.geoMid = new THREE.SphereGeometry(1, 20, 10);
		if (!this.geoLow) this.geoLow = new THREE.SphereGeometry(1, 12, 6);

		this.orbitalMechanics.computeSystemMaxDepths(parsedGraph);
		const { forceNodeList, forceLinkList } = this.buildForceData(parsedGraph);
		this.orbitalMechanics.buildOrbitalChildren(parsedGraph);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const factory = ForceGraph3D as any;
		this.graph = factory()(this.containerEl);

		const controls = this.graph.controls();
		if (controls) {
			controls.mouseButtons = {
				LEFT: 0,
				MIDDLE: 1,
				RIGHT: 2
			};
		}

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
			.nodeLabel(() => null)
			.nodeThreeObject((node: object) => createParentObject(
				node as ForceNode, 
				true, 
				isLight,
				this.geoHighest,
				this.geoHigh,
				this.geoMid,
				this.geoLow
			))
			.nodeThreeObjectExtend(false)
			.linkColor(() => lineColorHex)
			.linkWidth(linkWidth)
			.linkOpacity(lineOpacity)
			.warmupTicks(50)
			.cooldownTime(5000)
			.onNodeDrag(() => {
				this.isNodeDragging = true;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const controls = (this.graph as any)?.controls?.();
				if (controls) {
					controls.autoRotate = false;
				}
			})
			.onNodeDragEnd(() => {
				this.isNodeDragging = false;
			})
			.onEngineTick(() => {
				this.isEngineRunning = true;
			})
			.onEngineStop(() => this.onEngineStop())
			.graphData({ nodes: forceNodeList, links: forceLinkList });

		this.graph.d3Force('link', null);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const d3 = (window as any).d3;
		if (d3 && typeof d3.forceManyBody === 'function') {
			this.graph.d3Force('charge', d3.forceManyBody().strength(-250 * (this.settings.nodeSizeScale ?? 1.0)));
		} else {
			this.graph.d3Force('charge')?.strength(-250);
		}

		if (d3 && typeof d3.forceCenter === 'function') {
			this.graph.d3Force('center', d3.forceCenter(0, 0, 0));
		}

		if (d3 && typeof d3.forceX === 'function') {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			this.graph.d3Force('x', d3.forceX((n: any) => n.targetX ?? 0).strength(0.12));
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			this.graph.d3Force('y', d3.forceY((n: any) => n.targetY ?? 0).strength(0.12));
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			this.graph.d3Force('z', d3.forceZ((n: any) => n.targetZ ?? 0).strength(0.12));
		}

		this.addChildrenToScene();

		const scene = this.graph.scene();
		if (scene) {
			this.galacticCoreObj = createGalacticCoreObject();
			this.galacticCoreObj.visible = this.settings.showAxis ?? false;
			scene.add(this.galacticCoreObj);
		}

		setTimeout(() => {
			if (this.graph) {
				this.graph.zoomToFit(1000, 100);
			}
		}, 100);

		this.interactionHandler.setupPointerClickListener();
		this.startAnimationLoop();
	}

	cleanup(): void {
		this.stopAnimationLoop();

		if (this.graph) {
			const scene = this.graph.scene();
			if (scene && this.galacticCoreObj) {
				scene.remove(this.galacticCoreObj);
				this.galacticCoreObj = null;
			}
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

	private buildForceData(parsedGraph: ParsedGraph): {
		forceNodeList: ForceNode[];
		forceLinkList: ForceLink[];
	} {
		this.forceNodes.clear();
		const forceNodeList: ForceNode[] = [];
		const forceLinkList: ForceLink[] = [];

		const rootCount = parsedGraph.roots.length;
		const baseRadius = rootCount > 1 ? rootCount * 60 : 0;
		const groupTargetMap = new Map<string, THREE.Vector3>();

		for (let i = 0; i < rootCount; i++) {
			const rootId = parsedGraph.roots[i]!;
			const theta = (i / rootCount) * Math.PI * 2;
			const r = baseRadius * (0.8 + 0.4 * Math.random());
			const y = (Math.random() - 0.5) * 0.2;
			groupTargetMap.set(rootId, new THREE.Vector3(
				r * Math.cos(theta),
				y * baseRadius,
				r * Math.sin(theta)
			));
		}

		for (const rootId of parsedGraph.roots) {
			const node = parsedGraph.nodes.get(rootId);
			if (!node) continue;

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

	private addChildrenToScene(): void {
		if (!this.graph) return;
		const scene = this.graph.scene();
		if (!scene) return;

		for (const childId of this.orderedChildIds) {
			const child = this.orbitalChildren.get(childId);
			if (!child) continue;
			this.orbitalMechanics.updateChildWorldPosition(childId);
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

	private startAnimationLoop(): void {
		if (this.animFrameId !== null) return;
		const loop = () => {
			this.updateOrbitalAnimation();
			this.animFrameId = requestAnimationFrame(loop);
		};
		this.animFrameId = requestAnimationFrame(loop);
	}

	private stopAnimationLoop(): void {
		if (this.animFrameId !== null) {
			cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}
	}

	private getMainGraphGroup(scene: THREE.Scene): THREE.Object3D | null {
		let target: THREE.Object3D | undefined = undefined;
		let maxScore = -1;

		for (const child of scene.children) {
			if (child.type.includes('Light')) continue;
			if (child.type === 'LOD' || child.type === 'Line') continue;
			
			if (child.type === 'Group' || child.constructor.name === 'ThreeForceGraph') {
				// 1. Exclude Camera/Helper groups (containing AxesHelper or PerspectiveCamera)
				const isHelperGroup = child.children?.some(c => 
					c.type === 'AxesHelper' || 
					c.constructor.name === 'AxesHelper' ||
					c.type === 'PerspectiveCamera'
				);
				if (isHelperGroup) continue;

				// 2. Score the group based on its characteristics to find the true graph group
				let score = 0;
				if (child.constructor.name === 'ThreeForceGraph') {
					score += 10000;
				}
				if (child.children) {
					score += child.children.length;
					const hasGraphElements = child.children.some(c => 
						c.type === 'LOD' || 
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(c as any).__data !== undefined
					);
					if (hasGraphElements) {
						score += 5000;
					}
				}

				if (score > maxScore) {
					maxScore = score;
					target = child;
				}
			}
		}
		return target || null;
	}

	private updateOrbitalAnimation(): void {
		const now = performance.now();
		const dt = Math.min((now - this.lastTickTime) / 1000, 0.1);
		this.lastTickTime = now;

		const speed = this.settings.galacticRotation ? (this.settings.keplerBaseOmega >= 0 ? this.settings.keplerBaseOmega : 5) : 0;
		if (speed !== 0 && this.graph && !this.isNodeDragging) {
			const scene = this.graph.scene();
			if (scene) {
				const mainGroup = this.getMainGraphGroup(scene);
				
				if (mainGroup) {
					mainGroup.rotation.y += speed * dt * 0.1;
				}
			}
		}

		const isPaused = this.settings.keplerBaseOmega === 0;
		if (!isPaused) {
			for (const childId of this.orderedChildIds) {
				const child = this.orbitalChildren.get(childId);
				if (!child) continue;
				child.theta += child.omega * dt;
				this.orbitalMechanics.updateChildWorldPosition(childId);
			}
		} else {
			for (const childId of this.orderedChildIds) {
				this.orbitalMechanics.updateChildWorldPosition(childId);
			}
		}

		if (this.graph) {
			const camera = this.graph.camera();
			if (camera) {
				for (const child of this.orbitalChildren.values()) {
					const dist = camera.position.distanceTo(child.lod.position);
					updateNodeDistanceOpacity(child.lod, dist);
					child.lod.update(camera);
					if (child.orbitTraceObj) {
						updateNodeDistanceOpacity(child.orbitTraceObj, dist);
					}
					if (child.parentLineObjs) {
						for (const pLine of child.parentLineObjs) {
							updateNodeDistanceOpacity(pLine, dist);
						}
					}
				}

				for (const forceNode of this.forceNodes.values()) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const threeObj = (forceNode as any).__threeObj;
					if (threeObj) {
						const dist = camera.position.distanceTo(threeObj.position);
						updateNodeDistanceOpacity(threeObj, dist);
						if (threeObj.isLOD) {
							threeObj.update(camera);
						}
					}
				}
			}
		}

		this.cameraControls.updateCameraTracking();

		if (this.graph) {
			const scene = this.graph.scene();
			const camera = this.graph.camera();
			const renderer = this.graph.renderer();
			
			if (!this.isEngineRunning && scene && camera && renderer) {
				renderer.render(scene, camera);
			}
		}
	}

	private onEngineStop(): void {
		this.isEngineRunning = false;
		for (const forceNode of this.forceNodes.values()) {
			if (forceNode.x !== undefined && forceNode.y !== undefined && forceNode.z !== undefined) {
				forceNode.fx = forceNode.x;
				forceNode.fy = forceNode.y;
				forceNode.fz = forceNode.z;
			}
		}
	}
}
