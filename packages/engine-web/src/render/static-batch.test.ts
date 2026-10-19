import { BoxGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { batchStaticMeshes } from './static-batch.js';

const add = (root: Group, material: MeshStandardMaterial, x: number) => {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.position.x = x;
  mesh.castShadow = mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
};

describe('static mesh batching', () => {
  it('preserves transformed vertices, normals, triangles and building ray hits', () => {
    const root = new Group(), material = new MeshStandardMaterial();
    root.position.set(3, 2, -4); root.rotation.y = 0.4; root.userData.buildingId = 'home';
    const a = add(root, material, 0), b = add(root, material, 2);
    b.rotation.y = 0.7; b.scale.set(1, 2, 1);
    root.updateMatrixWorld(true);
    const inverse = root.matrixWorld.clone().invert();
    const expected = [a, b].map(m => m.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inverse, m.matrixWorld)));
    expect(batchStaticMeshes(root)).toBe(1);
    const merged = root.children[0] as Mesh;
    for (const name of ['position', 'normal', 'uv']) {
      const actual = Array.from(merged.geometry.getAttribute(name).array);
      const values = expected.flatMap(g => Array.from(g.getAttribute(name).array));
      expect(actual.length).toBe(values.length);
      actual.forEach((n, i) => expect(n).toBeCloseTo(values[i]!, 5));
    }
    expect(merged.geometry.index!.count).toBe(72);
    root.updateMatrixWorld(true);
    const hit = new Raycaster(new Vector3(3, 10, -4), new Vector3(0, -1, 0)).intersectObject(root, true)[0]!;
    expect(hit.object.parent?.userData.buildingId).toBe('home');
    expect(hit.point.y).toBeCloseTo(2.5);
    expect(merged.castShadow && merged.receiveShadow).toBe(true);
    expected.forEach(g => g.dispose());
  });

  it('retains transparent, independently animated, invisible and differently layered objects', () => {
    const root = new Group(), mat = new MeshStandardMaterial(), glass = new MeshStandardMaterial({ transparent:true, opacity:0.4 });
    const spin = add(root, mat, 0), invisible = add(root, mat, 1), layered = add(root, mat, 2);
    invisible.visible = false; layered.layers.enable(1);
    const t1 = add(root, glass, 3), t2 = add(root, glass, 4);
    add(root, mat, 5); add(root, mat, 6);
    expect(batchStaticMeshes(root, new Set([spin]))).toBe(1);
    for (const object of [spin, invisible, layered, t1, t2]) expect(root.children).toContain(object);
    expect(root.children).toHaveLength(6);
  });

  it('does not merge meshes with different shadow or picking behavior', () => {
    const root = new Group(), mat = new MeshStandardMaterial();
    add(root, mat, 0); add(root, mat, 1).castShadow = false;
    add(root, mat, 2).raycast = () => {};
    expect(batchStaticMeshes(root)).toBe(0);
  });

  it('releases owned source geometry once while retaining shared and excluded buffers', () => {
    const root = new Group(), mat = new MeshStandardMaterial();
    const a = add(root, mat, 0), b = add(root, mat, 1);
    const disposeA = vi.spyOn(a.geometry, 'dispose'), disposeB = vi.spyOn(b.geometry, 'dispose');
    b.geometry.userData.shared = true;
    expect(batchStaticMeshes(root)).toBe(1);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();
    expect((root.children[0] as Mesh).geometry.userData.shared).toBeUndefined();
  });
})
