import * as THREE from 'three';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { OrbitPluginSettings } from '../types';

/** Node data fed to 3d-force-graph's graphData (all nodes in vault). */
export interface ForceNode {
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
	fx?: number;
	fy?: number;
	fz?: number;
}

/** Link data fed to 3d-force-graph's graphData (parent-to-parent only). */
export interface ForceLink {
	source: string;
	target: string;
}

/** Flat orbital child node — exists only as scene objects + math state with LOD. */
export interface OrbitalChild {
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

export interface Graph3DContext {
	getGraph(): ForceGraph3DInstance | null;
	getSettings(): OrbitPluginSettings;
	getForceNodes(): Map<string, ForceNode>;
	getOrbitalChildren(): Map<string, OrbitalChild>;
	getSystemMaxDepths(): Map<string, number>;
	getSortedChildrenCache(): Map<string, string[]>;
	getOrderedChildIds(): string[];
	
	setOrderedChildIds(ids: string[]): void;

	getFocusedNodeId(): string | null;
	setFocusedNodeId(id: string | null): void;
	
	getNodeWorldPosition(nodeId: string): { x: number; y: number; z: number } | null;
	getNodeLocalPosition(nodeId: string): { x: number; y: number; z: number } | null;
	
	getCameraOffset(): THREE.Vector3;
	
	// Geometries for LOD
	geoHighest: THREE.SphereGeometry;
	geoHigh: THREE.SphereGeometry;
	geoMid: THREE.SphereGeometry;
	geoLow: THREE.SphereGeometry;
	
	// Core object
	galacticCoreObj: THREE.Group | null;
	setGalacticCoreObj(obj: THREE.Group | null): void;

	// Internal state tracking
	isNodeDragging: boolean;
	clickPointerDownPos: { x: number; y: number } | null;
	isLmbDragging: boolean;
	pendingRmbTargetNodeId: string | null;
	pendingRmbDownPos: { x: number; y: number } | null;
	isRmbDragging: boolean;
	pendingMmbDownPos: { x: number; y: number } | null;
	isMmbDragging: boolean;

	// Event callbacks
	onNodeClickCallback: ((nodeId: string) => void) | null;
	onNodeRightClickCallback: ((nodeId: string) => void) | null;
	onFocusChangeCallback: ((nodeId: string | null) => void) | null;
}
