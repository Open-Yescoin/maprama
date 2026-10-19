/** 合并同一交互/动画根下的静态不透明网格；保留材质、深度、层与拾取语义。 */
import { Matrix4, Mesh, type BufferGeometry, type Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function batchStaticMeshes(root: Object3D, excluded: ReadonlySet<Object3D> = new Set()): number {
  root.updateWorldMatrix(true, true);
  if (root.matrixWorld.determinant() === 0) return 0;
  const inverse = root.matrixWorld.clone().invert();
  const buckets = new Map<string, Mesh[]>();
  const raycasts = new Map<Mesh['raycast'], number>();
  const visit = (node: Object3D): void => {
    if (excluded.has(node) || !node.visible) return;
    if (node instanceof Mesh) {
      const material = node.material, geometry = node.geometry;
      if (node.type !== 'Mesh' || Array.isArray(material) || material.transparent || !material.visible || node.children.length
        || node.morphTargetInfluences || Object.keys(geometry.morphAttributes).length || node.customDepthMaterial || node.customDistanceMaterial
        || node.onBeforeRender !== Mesh.prototype.onBeforeRender || node.onAfterRender !== Mesh.prototype.onAfterRender
        || node.onBeforeShadow !== Mesh.prototype.onBeforeShadow || node.onAfterShadow !== Mesh.prototype.onAfterShadow
        || geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity || node.matrixWorld.determinant() <= 0) return;
      if (!raycasts.has(node.raycast)) raycasts.set(node.raycast, raycasts.size);
      const attributes = Object.keys(geometry.attributes).sort().map(name => {
        const a = geometry.getAttribute(name);
        return `${name}:${a.itemSize}:${a.normalized}:${a.array.constructor.name}:${'gpuType' in a ? a.gpuType : ''}`;
      }).join('|');
      const key = [material.id, node.layers.mask, node.castShadow, node.receiveShadow, node.renderOrder, node.frustumCulled, raycasts.get(node.raycast), !!geometry.index, attributes].join(';');
      const bucket = buckets.get(key) ?? [];
      bucket.push(node);
      buckets.set(key, bucket);
      return;
    }
    if (node.renderOrder !== 0) return;
    for (const child of node.children) visit(child);
  };
  for (const child of root.children) visit(child);
  const obsolete = new Set<BufferGeometry>();
  let removed = 0;
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map(mesh => mesh.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inverse, mesh.matrixWorld)));
    const geometry = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    if (!geometry) continue;
    // A clone of a shared source must still own and release its merged buffer.
    delete geometry.userData.shared;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const first = meshes[0]!;
    const batch = new Mesh(geometry, first.material);
    batch.name = 'static-batch';
    batch.layers.mask = first.layers.mask;
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    batch.renderOrder = first.renderOrder;
    batch.frustumCulled = first.frustumCulled;
    batch.raycast = first.raycast;
    for (const mesh of meshes) {
      mesh.removeFromParent();
      obsolete.add(mesh.geometry);
    }
    root.add(batch);
    removed += meshes.length - 1;
  }
  root.traverse(node => { if (node instanceof Mesh) obsolete.delete(node.geometry); });
  for (const geometry of obsolete) if (!geometry.userData.shared) geometry.dispose();
  return removed;
}
