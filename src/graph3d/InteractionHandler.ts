import * as THREE from 'three';
import type { Graph3DContext } from './types';
import type { NodeFocusedCameraControls } from './NodeFocusedCameraControls';

export class InteractionHandler {
	private isPointerListenerSetup: boolean = false;

	constructor(private context: Graph3DContext, private cameraControls: NodeFocusedCameraControls) {}

	public raycastNodeAtPointer(e: PointerEvent): string | null {
		const graph = this.context.getGraph();
		if (!graph) return null;
		
		const camera = graph.camera();
		const containerEl = graph.renderer().domElement.parentElement;
		if (!camera || !containerEl) return null;

		const rect = containerEl.getBoundingClientRect();
		const mouse = new THREE.Vector2(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-((e.clientY - rect.top) / rect.height) * 2 + 1
		);

		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(mouse, camera);

		const targets: THREE.Object3D[] = [];
		const objectToNodeIdMap = new Map<THREE.Object3D, string>();

		for (const [childId, child] of this.context.getOrbitalChildren().entries()) {
			targets.push(child.lod);
			objectToNodeIdMap.set(child.lod, childId);
		}

		for (const [rootId, forceNode] of this.context.getForceNodes().entries()) {
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

	public setupPointerClickListener(): void {
		const graph = this.context.getGraph();
		if (!graph || this.isPointerListenerSetup) return;
		
		const containerEl = graph.renderer().domElement.parentElement;
		if (!containerEl) return;
		
		this.isPointerListenerSetup = true;

		containerEl.addEventListener('wheel', (e: WheelEvent) => {
			if (this.context.getFocusedNodeId() && this.context.getGraph()) {
				const factor = Math.pow(1.0015, e.deltaY);
				const cameraOffset = this.context.getCameraOffset();
				const currentDist = cameraOffset.length();
				const newDist = Math.max(20, Math.min(15000, currentDist * factor));
				if (currentDist > 0) {
					cameraOffset.setLength(newDist);
				} else {
					cameraOffset.set(0, 0, newDist);
				}
			}
		}, { passive: true });

		containerEl.addEventListener('contextmenu', (e: MouseEvent) => {
			e.preventDefault();
		});

		containerEl.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button === 2) {
				this.context.pendingRmbDownPos = { x: e.clientX, y: e.clientY };
				this.context.pendingRmbTargetNodeId = this.raycastNodeAtPointer(e);
				this.context.isRmbDragging = false;
			} else if (e.button === 1) { // Middle click
				this.context.pendingMmbDownPos = { x: e.clientX, y: e.clientY };
				this.context.isMmbDragging = false;
			} else if (e.button === 0) {
				this.context.clickPointerDownPos = { x: e.clientX, y: e.clientY };
				this.context.isLmbDragging = false;
			}
		});

		containerEl.addEventListener('pointermove', (e: PointerEvent) => {
			if (this.context.pendingRmbDownPos && !this.context.isRmbDragging) {
				const dx = e.clientX - this.context.pendingRmbDownPos.x;
				const dy = e.clientY - this.context.pendingRmbDownPos.y;
				const dist = Math.hypot(dx, dy);
				
				if (dist >= 3) {
					this.context.isRmbDragging = true;
					this.context.pendingRmbTargetNodeId = null;
					this.cameraControls.clearFocusedNode();
				}
			}
			if (this.context.pendingMmbDownPos && !this.context.isMmbDragging) {
				const dx = e.clientX - this.context.pendingMmbDownPos.x;
				const dy = e.clientY - this.context.pendingMmbDownPos.y;
				const dist = Math.hypot(dx, dy);
				
				if (dist >= 3) {
					this.context.isMmbDragging = true;
					this.cameraControls.clearFocusedNode();
				}
			}
			if (this.context.clickPointerDownPos && !this.context.isLmbDragging) {
				const dx = e.clientX - this.context.clickPointerDownPos.x;
				const dy = e.clientY - this.context.clickPointerDownPos.y;
				const dist = Math.hypot(dx, dy);
				
				if (dist >= 3) {
					this.context.isLmbDragging = true;
				}
			}
		});

		containerEl.addEventListener('pointerup', (e: PointerEvent) => {
			if (e.button === 2 && this.context.pendingRmbDownPos) {
				if (!this.context.isRmbDragging) {
					const hitNodeId = this.context.pendingRmbTargetNodeId;
					if (hitNodeId) {
						if (this.context.getFocusedNodeId() === hitNodeId) {
							// Maintain focus
						} else {
							this.cameraControls.setFocusedNode(hitNodeId);
							if (this.context.onNodeRightClickCallback) {
								this.context.onNodeRightClickCallback(hitNodeId);
							}
						}
					} else {
						this.cameraControls.clearFocusedNode();
					}
				}
				this.context.pendingRmbDownPos = null;
				this.context.pendingRmbTargetNodeId = null;
				this.context.isRmbDragging = false;
			} else if (e.button === 0 && this.context.clickPointerDownPos) {
				const dx = e.clientX - this.context.clickPointerDownPos.x;
				const dy = e.clientY - this.context.clickPointerDownPos.y;
				const dist = Math.hypot(dx, dy);
				if (dist < 3) {
					const hitNodeId = this.raycastNodeAtPointer(e);
					if (hitNodeId && this.context.onNodeClickCallback) {
						this.context.onNodeClickCallback(hitNodeId);
					}
				}
				this.context.clickPointerDownPos = null;
				this.context.isLmbDragging = false;
			} else if (e.button === 1 && this.context.pendingMmbDownPos) {
				this.context.pendingMmbDownPos = null;
				this.context.isMmbDragging = false;
			}
		});
	}
}
