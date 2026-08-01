import * as THREE from 'three';
import SpriteText from 'three-spritetext';
import type { ForceNode } from './types';


export const BASE_NODE_SCALE = 30;
export const BASE_ORBIT_SCALE = 240;

export function getNodeRelativeSizes(
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

export function createTranslucentLineMaterial(lineColorHex: string, baseOpacity: number = 1.0): THREE.ShaderMaterial {
	return new THREE.ShaderMaterial({
		uniforms: {
			uColor: { value: new THREE.Color(lineColorHex) },
			uOpacity: { value: baseOpacity },
		},
		vertexShader: `
			attribute float aAlpha;
			varying float vAlpha;
			void main() {
				vAlpha = aAlpha;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: `
			uniform vec3 uColor;
			uniform float uOpacity;
			varying float vAlpha;
			void main() {
				gl_FragColor = vec4(uColor, vAlpha * uOpacity);
			}
		`,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});
}

export function createGalacticCoreObject(): THREE.Group {
	const group = new THREE.Group();

	const coreGeo = new THREE.SphereGeometry(6, 16, 16);
	const coreMat = new THREE.MeshBasicMaterial({
		color: 0xffffff,
		transparent: true,
		opacity: 0.95,
	});
	const coreMesh = new THREE.Mesh(coreGeo, coreMat);
	group.add(coreMesh);

	const haloGeo = new THREE.SphereGeometry(14, 16, 16);
	const haloMat = new THREE.MeshBasicMaterial({
		color: 0xffffff,
		transparent: true,
		opacity: 0.35,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	});
	const haloMesh = new THREE.Mesh(haloGeo, haloMat);
	group.add(haloMesh);

	const axesHelper = new THREE.AxesHelper(100);
	group.add(axesHelper);

	group.position.set(0, 0, 0);
	group.renderOrder = 0;
	return group;
}

export function createParentObject(
	node: ForceNode,
	showLabels: boolean,
	isLight: boolean,
	geoHighest: THREE.SphereGeometry,
	geoHigh: THREE.SphereGeometry,
	geoMid: THREE.SphereGeometry,
	geoLow: THREE.SphereGeometry
): THREE.Object3D {
	const lod = new THREE.LOD();
	const baseRadius = node.renderRadius;

	const { nodeRadius } = getNodeRelativeSizes(node.id, node.depth, node.systemMaxDepth);
	const isHighest = nodeRadius >= 2;

	const matConfig: THREE.MeshLambertMaterialParameters = {
		color: node.color,
		transparent: true,
		opacity: 1.0,
		emissive: node.color,
		emissiveIntensity: 0.4,
	};
	const material = new THREE.MeshLambertMaterial(matConfig);

	const meshHigh = new THREE.Mesh(isHighest ? geoHighest : geoHigh, material);
	meshHigh.scale.setScalar(baseRadius);
	lod.addLevel(meshHigh, 0);

	const meshMid = new THREE.Mesh(geoMid, material);
	meshMid.scale.setScalar(baseRadius);
	lod.addLevel(meshMid, 1000);

	const meshLow = new THREE.Mesh(geoLow, material);
	meshLow.scale.setScalar(baseRadius);
	lod.addLevel(meshLow, 1500);

	if (showLabels && node.label) {
		const sprite = new SpriteText(node.label);
		sprite.color = isLight ? '#000000' : '#ffffff';
		sprite.backgroundColor = 'rgba(0, 0, 0, 0)';
		sprite.borderColor = 'rgba(0, 0, 0, 0)';
		sprite.borderWidth = 0;
		sprite.padding = 0;
		sprite.textHeight = 4;
		sprite.center.set(0.5, 0);
		sprite.position.set(0, baseRadius + 1.5, 0);
		
		// Fix depth occlusion issue for labels
		sprite.material.depthWrite = false;
		sprite.material.alphaTest = 0.1;
		sprite.renderOrder = 999;
		
		// Disable raycasting so the label ignores mouse events
		sprite.raycast = () => {};

		const baseScale = sprite.scale.clone();
		sprite.onBeforeRender = (renderer, scene, camera) => {
			const dist = camera.position.distanceTo(sprite.getWorldPosition(new THREE.Vector3()));
			const scaleFactor = Math.max(1.0, dist / 250);
			sprite.scale.set(baseScale.x * scaleFactor, baseScale.y * scaleFactor, baseScale.z * scaleFactor);
		};
		lod.add(sprite);
	}

	return lod;
}

export function updateLODObjectScalesAndColors(
	lodObj: THREE.LOD,
	renderRadius: number,
	colorHex: string,
	isLight: boolean
): void {
	const colorObj = new THREE.Color(colorHex);
	const labelHighColor = isLight ? '#000000' : '#ffffff';

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
						(mat as THREE.MeshLambertMaterial).emissive.copy(colorObj);
					}
				}
			}
		} else if (child instanceof SpriteText) {
			child.color = labelHighColor;
			child.position.setY(renderRadius + 1.5);
		}
	});
}

export function updateNodeDistanceOpacity(nodeObj: THREE.Object3D, distance: number): void {
	if (distance >= 52000) {
		nodeObj.visible = false;
		return;
	}
	nodeObj.visible = true;

	/* 
	거리가 멀어지면 투명해지도록 하는 코드 주석 처리 (항상 원래 투명도 유지)
	if (distance < 2000) {
		setObjectOpacity(nodeObj, 1.0);
	} else {
		const alphaMult = Math.max(0, 1.0 - Math.floor((distance - 2000) / 200) * 0.1);
		setObjectOpacity(nodeObj, alphaMult);
	}
	*/
}

export function setObjectOpacity(obj: THREE.Object3D, alphaMult: number): void {
	obj.traverse((child) => {
		if ((child as THREE.Mesh).isMesh || (child as THREE.Sprite).isSprite) {
			const renderObj = child as THREE.Mesh | THREE.Sprite;
			if (renderObj.material) {
				const materials = Array.isArray(renderObj.material) ? renderObj.material : [renderObj.material];
				for (const mat of materials) {
					mat.transparent = true;
					mat.opacity = alphaMult;
				}
			}
		}
	});
}
