import type { Graph3DContext } from './types';

export class NodeFocusedCameraControls {
	constructor(private context: Graph3DContext) {}

	public setFocusedNode(nodeId: string | null): void {
		const current = this.context.getFocusedNodeId();
		const changed = current !== nodeId;
		this.context.setFocusedNodeId(nodeId);

		if (changed && this.context.onFocusChangeCallback) {
			this.context.onFocusChangeCallback(nodeId);
		}

		const graph = this.context.getGraph();
		if (!nodeId || !graph) return;

		const targetPos = this.context.getNodeWorldPosition(nodeId);
		if (!targetPos) return;

		const camera = graph.camera();
		if (camera) {
			const offset = this.context.getCameraOffset();
			const camX = targetPos.x + offset.x;
			const camY = targetPos.y + offset.y;
			const camZ = targetPos.z + offset.z;

			graph.cameraPosition(
				{ x: camX, y: camY, z: camZ },
				{ x: targetPos.x, y: targetPos.y, z: targetPos.z },
				1000
			);
		}
	}

	public clearFocusedNode(): void {
		const current = this.context.getFocusedNodeId();
		if (current !== null) {
			this.context.setFocusedNodeId(null);
			if (this.context.onFocusChangeCallback) {
				this.context.onFocusChangeCallback(null);
			}
		}
	}

	public updateCameraTracking(): void {
		const focusedNodeId = this.context.getFocusedNodeId();
		const graph = this.context.getGraph();
		const isRmbDragging = this.context.isRmbDragging;
		const isNodeDragging = this.context.isNodeDragging;
		const isLmbDragging = this.context.isLmbDragging;
		const isMmbDragging = this.context.isMmbDragging;

		if (focusedNodeId && graph && !isRmbDragging && !isMmbDragging) {
			const targetPos = this.context.getNodeWorldPosition(focusedNodeId);
			if (targetPos) {
				const camera = graph.camera();
				const controls = graph.controls() as { target?: { set: (x: number, y: number, z: number) => void } } | undefined;
				
				if (camera) {
					// OrbitControls' target should always follow the focused node so we can orbit around it
					if (controls && controls.target && typeof controls.target.set === 'function') {
						controls.target.set(targetPos.x, targetPos.y, targetPos.z);
					}

					// We only force camera position if the user is NOT dragging the camera with left click.
					// If they are orbiting (left click drag), we let OrbitControls do its job!
					if (!isNodeDragging && !isLmbDragging) {
						// Only force position when not dragging
						const offset = this.context.getCameraOffset();
						const camX = targetPos.x + offset.x;
						const camY = targetPos.y + offset.y;
						const camZ = targetPos.z + offset.z;
						graph.cameraPosition(
							{ x: camX, y: camY, z: camZ },
							{ x: targetPos.x, y: targetPos.y, z: targetPos.z },
							0
						);
					} else if (!isNodeDragging && isLmbDragging) {
						// If dragging, we should update the offset so that when dragging stops, 
						// the camera stays at the new offset relative to the node, instead of snapping back.
						const offset = this.context.getCameraOffset();
						offset.set(
							camera.position.x - targetPos.x,
							camera.position.y - targetPos.y,
							camera.position.z - targetPos.z
						);
					}
				}
			}
		}
	}
}
