import * as THREE from 'three';
import SpriteText from 'three-spritetext';
import type { ParsedGraph } from '../types';
import type { Graph3DContext, OrbitalChild } from './types';
import { BASE_ORBIT_SCALE, BASE_NODE_SCALE, getNodeRelativeSizes, createTranslucentLineMaterial } from './SceneBuilder';
import { getNodeColor } from '../renderer';

export class OrbitalMechanics {
	constructor(private context: Graph3DContext) {}

	public computeSystemMaxDepths(parsedGraph: ParsedGraph): void {
		const depths = this.context.getSystemMaxDepths();
		depths.clear();
		for (const rootId of parsedGraph.roots) {
			let maxDepth = 0;
			const stack = [rootId];
			const visited = new Set<string>();
			while (stack.length > 0) {
				const curr = stack.pop()!;
				if (visited.has(curr)) continue;
				visited.add(curr);

				const node = parsedGraph.nodes.get(curr);
				if (node) {
					if (node.depth > maxDepth) {
						maxDepth = node.depth;
					}
					for (const childId of node.children) {
						stack.push(childId);
					}
				}
			}
			depths.set(rootId, maxDepth);
			const childStack = [rootId];
			const childVisited = new Set<string>();
			while (childStack.length > 0) {
				const curr = childStack.pop()!;
				if (childVisited.has(curr)) continue;
				childVisited.add(curr);

				const node = parsedGraph.nodes.get(curr);
				if (node) {
					if (curr !== rootId) {
						depths.set(curr, maxDepth);
					}
					for (const childId of node.children) {
						childStack.push(childId);
					}
				}
			}
		}
	}

	public buildOrbitalChildren(parsedGraph: ParsedGraph): void {
		const orbitalChildren = this.context.getOrbitalChildren();
		const sortedCache = this.context.getSortedChildrenCache();
		orbitalChildren.clear();
		sortedCache.clear();
		
		const childEntries: { id: string; depth: number }[] = [];
		const queue = [...parsedGraph.roots];
		const visited = new Set<string>(parsedGraph.roots);
		const settings = this.context.getSettings();

		while (queue.length > 0) {
			const parentId = queue.shift()!;
			const parentNode = parsedGraph.nodes.get(parentId);
			if (!parentNode) continue;

			const sortedChildren = this.sortSiblings(parentNode.children, parsedGraph);
			sortedCache.set(parentId, sortedChildren);

			for (let i = 0; i < sortedChildren.length; i++) {
				const childId = sortedChildren[i]!;
				if (visited.has(childId)) continue;
				visited.add(childId);

				const childNode = parsedGraph.nodes.get(childId);
				if (!childNode) continue;

				const systemMaxDepth = this.context.getSystemMaxDepths().get(childId) ?? 0;
				const { nodeRadius: childRelNode, orbitRadius: childRelOrbit } =
					getNodeRelativeSizes(childId, childNode.depth, systemMaxDepth);

				let radius = childRelOrbit * BASE_ORBIT_SCALE * settings.orbitRadiusScale;
				const N = sortedChildren.length;
				if (N > 1) {
					const scale = 0.5 + 1.0 * (i / (N - 1));
					radius *= scale;
				}

				let direction = 1;
				if (settings.orbitDirection === 'clockwise') {
					direction = 1;
				} else if (settings.orbitDirection === 'counterclockwise') {
					direction = -1;
				} else {
					direction = childNode.depth % 2 === 0 ? 1 : -1;
				}
				const baseOmega = settings.keplerBaseOmega >= 0 ? settings.keplerBaseOmega : 5;
				const omega = (radius > 0 ? (baseOmega / Math.sqrt(radius)) : 0) * direction;

				const theta = Math.random() * Math.PI * 2;
				const renderRadius = childRelNode * BASE_NODE_SCALE * settings.nodeSizeScale;
				const color = getNodeColor(childId, childNode.depth, settings.theme, systemMaxDepth, i);
				const colorObj = new THREE.Color(color);

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

				// Level 0
				const highGroup = new THREE.Group();
				const { nodeRadius } = getNodeRelativeSizes(childNode.id, childNode.depth, systemMaxDepth);
				const isHighest = nodeRadius >= 2;
				const highMesh = new THREE.Mesh(isHighest ? this.context.geoHighest : this.context.geoHigh, matHigh);
				highMesh.scale.setScalar(renderRadius);
				highMesh.renderOrder = 1;
				highGroup.add(highMesh);

				const isLight = settings.theme === 'light';
				const colorHigh = isLight ? '#000000' : '#ffffff';
				const colorMid = isLight ? '#000000' : '#ffffff';

				const labelHigh = new SpriteText(childNode.label, renderRadius * 0.8, colorHigh);
				labelHigh.fontFace = 'Inter, system-ui, sans-serif';
				labelHigh.backgroundColor = 'rgba(0, 0, 0, 0)';
				labelHigh.borderColor = 'rgba(0, 0, 0, 0)';
				labelHigh.borderWidth = 0;
				labelHigh.strokeWidth = 0;
				labelHigh.strokeColor = 'rgba(0, 0, 0, 0)';
				labelHigh.padding = 0;
				
				// Fix depth occlusion issue for labels
				labelHigh.material.depthWrite = false;
				labelHigh.material.alphaTest = 0.1;
				labelHigh.renderOrder = 999;
				labelHigh.raycast = () => {};
				(labelHigh as unknown as THREE.Object3D).position.y = -(renderRadius * 1.4);
				highGroup.add(labelHigh as unknown as THREE.Object3D);
				lod.addLevel(highGroup, 0);

				// Level 1
				const midGroup = new THREE.Group();
				const midMesh = new THREE.Mesh(this.context.geoMid, matMid);
				midMesh.scale.setScalar(renderRadius);
				midMesh.renderOrder = 1;
				midGroup.add(midMesh);

				const labelMid = new SpriteText(childNode.label, renderRadius * 0.8, colorMid);
				labelMid.fontFace = 'Inter, system-ui, sans-serif';
				labelMid.backgroundColor = 'rgba(0, 0, 0, 0)';
				labelMid.borderColor = 'rgba(0, 0, 0, 0)';
				labelMid.borderWidth = 0;
				labelMid.strokeWidth = 0;
				labelMid.strokeColor = 'rgba(0, 0, 0, 0)';
				labelMid.padding = 0;
				
				// Fix depth occlusion issue for labels
				labelMid.material.depthWrite = false;
				labelMid.material.alphaTest = 0.1;
				labelMid.renderOrder = 999;
				labelMid.raycast = () => {};
				(labelMid as unknown as THREE.Object3D).position.y = -(renderRadius * 1.4);
				midGroup.add(labelMid as unknown as THREE.Object3D);
				lod.addLevel(midGroup, 1000);

				// Level 2
				const lowMesh = new THREE.Mesh(this.context.geoLow, matLow);
				lowMesh.scale.setScalar(renderRadius);
				lowMesh.renderOrder = 1;
				lod.addLevel(lowMesh, 1500);

				const lineHex = isLight ? '#000000' : '#ffffff';
				const traceStyle = settings.orbitTraceStyle ?? 'translucent';
				const traceVisible = traceStyle !== 'hidden' && radius > 0;
				const traceOpacity = traceStyle === 'solid' ? 0.85 : 0.45;

				let orbitTraceObj: THREE.LineLoop | undefined;
				if (radius > 0) {
					const pts: THREE.Vector3[] = [];
					const segs = 64;
					const alphas = new Float32Array(segs);
					for (let k = 0; k < segs; k++) {
						const a = (k / segs) * Math.PI * 2;
						pts.push(new THREE.Vector3(radius * Math.cos(a), 0, radius * Math.sin(a)));
						alphas[k] = traceStyle === 'translucent' ? 0.15 : 1.0;
					}
					const traceGeo = new THREE.BufferGeometry().setFromPoints(pts);
					traceGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
					const traceMat = createTranslucentLineMaterial(lineHex, traceOpacity);
					orbitTraceObj = new THREE.LineLoop(traceGeo, traceMat);
					orbitTraceObj.renderOrder = 1;
					orbitTraceObj.visible = traceVisible;
				}

				const parentStyle = settings.lineToParentStyle ?? 'translucent';
				const parentLineVisible = parentStyle !== 'hidden';
				const parentLineOpacity = parentStyle === 'solid' ? 0.85 : 0.45;
				const parentLineObjs: THREE.Line[] = [];

				for (let pIdx = 0; pIdx < childNode.parents.length; pIdx++) {
					const pGeo = new THREE.BufferGeometry().setFromPoints([
						new THREE.Vector3(0, 0, 0),
						new THREE.Vector3(0, 0, 0),
						new THREE.Vector3(0, 0, 0),
					]);
					const pAlphas = parentStyle === 'translucent' ? new Float32Array([0.4, 0.2, 0.4]) : new Float32Array([1.0, 1.0, 1.0]);
					pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlphas, 1));
					const pMat = createTranslucentLineMaterial(lineHex, parentLineOpacity);
					const pLine = new THREE.Line(pGeo, pMat);
					pLine.renderOrder = 2;
					pLine.visible = parentLineVisible;
					parentLineObjs.push(pLine);
				}

				const orbChild: OrbitalChild = {
					id: childId,
					label: childNode.label,
					parentIds: childNode.parents,
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

				orbitalChildren.set(childId, orbChild);
				childEntries.push({ id: childId, depth: childNode.depth });
				queue.push(childId);
			}
		}

		childEntries.sort((a, b) => a.depth - b.depth);
		this.context.setOrderedChildIds(childEntries.map((e) => e.id));
	}

	private sortSiblings(childIds: string[], graph: ParsedGraph): string[] {
		const mode = this.context.getSettings().siblingSortMode;
		const arr = [...childIds];

		return arr.sort((a, b) => {
			const nodeA = graph.nodes.get(a);
			const nodeB = graph.nodes.get(b);
			if (!nodeA || !nodeB) return 0;

			if (mode === 'fileSize') {
				return nodeB.fileSize - nodeA.fileSize;
			} else if (mode === 'createdTime') {
				return nodeA.createdTime - nodeB.createdTime;
			} else if (mode === 'modifiedTime') {
				return nodeB.modifiedTime - nodeA.modifiedTime;
			}

			const labelA = nodeA.label.toLowerCase();
			const labelB = nodeB.label.toLowerCase();
			return labelA.localeCompare(labelB);
		});
	}

	private getParentWorldPositions(parentIds: string[], childId: string): THREE.Vector3[] {
		const positions: THREE.Vector3[] = [];
		for (const pid of parentIds) {
			const pPos = this.context.getNodeWorldPosition(pid);
			if (pPos) {
				positions.push(new THREE.Vector3(pPos.x, pPos.y, pPos.z));
			}
		}
		return positions;
	}

	public updateChildWorldPosition(childId: string): void {
		const child = this.context.getOrbitalChildren().get(childId);
		if (!child) return;

		const parentPositions = this.getParentWorldPositions(child.parentIds, childId);
		const numParents = parentPositions.length;

		if (numParents === 0) {
			child.lod.position.set(0, 0, 0);
			return;
		}

		let x = 0, y = 0, z = 0;
		const tracePoints: THREE.Vector3[] = [];
		const segs = 64;

		if (numParents === 1) {
			const p = parentPositions[0]!;
			const r = child.orbitRadius;
			x = p.x + r * Math.cos(child.theta);
			y = p.y;
			z = p.z + r * Math.sin(child.theta);

			if (child.orbitTraceObj) {
				for (let k = 0; k < segs; k++) {
					const angle = (k / segs) * Math.PI * 2;
					tracePoints.push(new THREE.Vector3(p.x + r * Math.cos(angle), p.y, p.z + r * Math.sin(angle)));
				}
			}
		} else if (numParents === 2 && (this.context.getSettings().dualParentOvalOrbit ?? true)) {
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

			const ref = Math.abs(u.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
			const v = new THREE.Vector3().crossVectors(u, ref).normalize();

			const a = d / 2 + child.orbitRadius;
			const b = a * 0.65;

			const xLocal = a * Math.cos(child.theta);
			const yLocal = b * Math.sin(child.theta);

			x = cx + xLocal * u.x + yLocal * v.x;
			y = cy + xLocal * u.y + yLocal * v.y;
			z = cz + xLocal * u.z + yLocal * v.z;

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
			y = cy;
			z = cz + orbitR * Math.sin(child.theta);

			if (child.orbitTraceObj) {
				for (let k = 0; k < segs; k++) {
					const angle = (k / segs) * Math.PI * 2;
					tracePoints.push(new THREE.Vector3(
						cx + orbitR * Math.cos(angle),
						cy,
						cz + orbitR * Math.sin(angle)
					));
				}
			}
		}

		child.lod.position.set(x, y, z);

		if (child.orbitTraceObj && tracePoints.length > 0) {
			child.orbitTraceObj.geometry.setFromPoints(tracePoints);
			child.orbitTraceObj.geometry.computeBoundingSphere();
		}

		if (child.parentLineObjs && child.parentLineObjs.length > 0) {
			const connectionPts: THREE.Vector3[] = [];
			const pPosList: THREE.Vector3[] = [];
			for (let pIdx = 0; pIdx < child.parentLineObjs.length; pIdx++) {
				if (pIdx < parentPositions.length) {
					pPosList.push(parentPositions[pIdx]!);
				} else {
					pPosList.push(parentPositions[0]!);
				}
			}

			for (let pIdx = 0; pIdx < child.parentLineObjs.length; pIdx++) {
				const pPos = pPosList[pIdx]!;
				const cPos = new THREE.Vector3(x, y, z);
				const midPos = new THREE.Vector3().lerpVectors(pPos, cPos, 0.5);

				connectionPts.length = 0;
				connectionPts.push(pPos, midPos, cPos);

				const lineObj = child.parentLineObjs[pIdx]!;
				lineObj.geometry.setFromPoints(connectionPts);
				lineObj.geometry.computeBoundingSphere();
			}
		}
	}
}
