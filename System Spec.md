# System Specification: 3D Galaxy Graph View (id: galaxy-graph)

This document specifies the logical rules, physics isolation, orbital mechanics, camera behavior, animation controls, and external codebase references for the `galaxy-graph` plugin.

---

## 1. Hierarchy & Physics Isolation Rules

Graph nodes are strictly divided into two categories: **Root Nodes (Top-level)** and **Child Nodes (Sub-nodes)**.

* **Top-level Root Nodes (Clustering Layer)**
  * **Physics Engine**: Governed by the 3D Force-Directed engine (Attraction/Repulsion).
  * **Behavior**: Aggregated around the world origin $(0, 0, 0)$ to form a central cluster based on 3D force physics.
* **Child Nodes (Orbital Layer)**
  * **Physics Isolation**: **Completely isolated from the 3D Force Simulation.** They do not exert or receive force vectors to/from any other nodes.
  * **Behavior**: Perform deterministic orbital motion exclusively relative to their direct Parent Node.

---

## 2. Orbital Mechanics (Child Nodes)

Child nodes move in circular orbits parallel to the **XZ-plane** centered at their parent's current position.

* **Position Equation**:
  $$\text{ChildPosition}(t) = \text{ParentWorldPosition} + \text{OrbitOffset}(t)$$
* **Orbit Trajectory Logic (based on child count $n$)**:
  * **$n = 1$**: Single circular orbit around the parent.
  * **$n = 2$**: Binary co-planar concentric/symmetric orbits (180° phase offset).
  * **$n \ge 3$**: Multi-body distributed orbital paths (evenly spaced angular offsets).
* **Kinematics**: Orbit trajectories update dynamically based on the parent's world position, retaining complete independence from global force dynamics.

---

## 3. Motion Systems & Orbit Speed Control

All continuous rotatory motions are driven by a global time variable modified by the **Orbit Speed** parameter.

* **Orbit Speed Parameter (`orbitSpeed`)**:
  * Global multiplier affecting all rotatory updates (`speed = 0` freezes rotation; `speed > 0` scales angular velocity).
* **Galactic Rotation (Global Rotation)**:
  * Top-level root cluster rotates around the world origin $(0,0,0)$ parallel to the XZ-plane.
  * *Implementation Note*: Rotates the main parent Group/Scene (`scene.rotation.y += baseGalacticSpeed * orbitSpeed`).
* **Node Orbit Rotation (Local Rotation)**:
  * Child nodes update their orbital angle relative to their parent (`angle += baseOrbitSpeed * orbitSpeed`).

---

## 4. Camera System & Node Focus Interactivity

The Camera Control System switches between **Free Navigation Mode** and **Focused Node Tracking Mode**.

* **Node Focus Mode (Active)**
  * **Target Lock**: Camera target locks to `FocusedNode.getWorldPosition()`.
  * **Orbit & Zoom**: Controls (Rotate / Zoom) operate relative to the locked target node as the origin.
  * **Dynamic Tracking**: When Galactic Rotation or Node Orbit is active, the camera continuously tracks (follows) the target node's moving World Position.
* **Pan Interaction & Focus Release**:
  * **Pan Action**: Executing a Pan operation immediately breaks the lock on `FocusedNode` and shifts the camera target away from the node center.
  * **State Transition**: **Node Focus state transitions to OFF immediately upon Pan start**, restoring default camera controls.

---

## 5. References & Dependencies

This plugin's design and architecture are built upon and referenced from the following core libraries and repositories located in `references/`:

* **`references/3d-force-graph-master`**: Core 3D force-directed graph structure, rendering loop, and mouse interaction handling.
* **`references/orbit-graph-view`**: Hierarchical orbital mechanics and child node trajectory logic.
* **`references/three-spritetext-master`**: Text sprite rendering and label orientation management for 3D nodes.
* **`references/three.js-dev`**: Fundamental 3D scene, camera matrix transformations, controls, and rendering engine.

---

## 6. Rendering Order

이 플러그인의 3D 뷰 렌더링 코어는 `src/graph3d/Graph3DManager.ts` 내의 `startAnimationLoop()` 와 `updateOrbitalAnimation()` 메서드에서 관리됩니다. 매 프레임(`requestAnimationFrame`)마다 실행되는 핵심 프레임 루프의 순서는 다음과 같습니다.

### 1. Delta Time (dt) 계산
- `performance.now()`를 이용해 이전 프레임과 현재 프레임 사이의 시간차(`dt`)를 구합니다. 애니메이션의 속도를 프레임 레이트에 구애받지 않고 일정하게 유지하기 위함입니다. (최대 0.1초 제한)

### 2. Galactic Rotation (전체 은하 회전)
- `settings.galacticRotation` 옵션이 켜져 있고, 사용자가 노드를 드래그 중이 아닐 때 실행됩니다.
- Three.js 씬(Scene)의 최상위 그룹 객체(mainGroup)의 `rotation.y` 값을 변경시켜 전체 그래프가 서서히 회전하도록 만듭니다.

### 3. Physics / Orbital Mechanics (위성 노드 궤도 업데이트)
- 정지 상태(keplerBaseOmega === 0)가 아니라면, 모든 위성 노드(`orbitalChildren`)의 궤도 각도(`theta`)를 `omega * dt` 만큼 증가시킵니다.
- `this.orbitalMechanics.updateChildWorldPosition(childId)`를 호출하여 변경된 각도를 바탕으로 3D 공간상의 실제 위치를 다시 계산하고 반영합니다.
- *(참고: 루트 노드들의 Force Directed 물리 연산은 `3d-force-graph` 내장 d3-force 엔진에 의해 백그라운드에서 별도로 Tick이 돌아가며 업데이트됩니다.)*

### 4. LOD (Level Of Detail) 및 가시성(Opacity) 업데이트
- 카메라의 현재 위치를 가져와 각 노드(루트 노드 및 위성 노드)와의 거리를 계산합니다.
- **Opacity:** `updateNodeDistanceOpacity()`를 통해 거리에 따른 노드(및 궤도선, 부모 연결선)의 투명도를 조절합니다. (거리가 멀어지면 흐려지거나 사라지게 렌더링 최적화)
- **LOD:** `child.lod.update(camera)`를 호출하여 카메라와의 거리에 따라 High/Mid/Low 폴리곤 모델 중 적절한 메쉬를 선택하여 렌더링 성능을 최적화합니다.

### 5. Camera Tracking & Controls (카메라 추적)
- `this.cameraControls.updateCameraTracking()`을 호출합니다.
- 특정 노드가 포커스된 경우(`focusedNodeId`), 해당 노드의 움직임에 맞춰 카메라가 부드럽게(Lerp 등) 따라가도록 목표 지점(Target)과 카메라 위치를 업데이트합니다.

### 6. Render (렌더링 수행)
- 최종적으로 Three.js의 `renderer.render(scene, camera)`를 호출하여 업데이트된 씬(Scene) 상태를 화면에 그립니다.

**요약하자면 흐름은 다음과 같습니다:**
시간차 계산 ➡️ 전체 축 회전 ➡️ 개별 위성 궤도 이동 계산 ➡️ 카메라 거리에 따른 렌더링 최적화(LOD/투명도) ➡️ 카메라 위치 보정(포커싱) ➡️ 최종 화면 그리기(Render)