/**
 * AR calibration is edited in a physical Z-up frame (X,Y on the table; Z vertical).
 * A-Frame / Three.js uses Y-up (X,Z horizontal; Y vertical).
 */

export type Vec3 = { x: number; y: number; z: number };

/** Map physical position offset to scene (Y-up) before adding marker-space centroid, etc. */
export function physicalOffsetToScene(pos: Vec3): Vec3 {
    return { x: pos.x, y: pos.z, z: pos.y };
}

/** Uniform scale in X/Z; depthScale stretches along physical Z → scene Y. */
export function physicalScaleToSceneString(globalScale: number, depthScale: number): string {
    const sx = globalScale;
    const sy = globalScale * depthScale;
    const sz = globalScale;
    return `${sx} ${sy} ${sz}`;
}

/**
 * Physical Euler (degrees), intrinsic XYZ on physical axes; output A-Frame rotation string (YXZ)
 * so it matches Three.js rotation component behavior.
 */
export function physicalEulerDegreesToSceneRotationString(rotDeg: Vec3): string {
    const THREE = typeof window !== 'undefined' ? (window as unknown as { THREE?: any }).THREE : undefined;
    const DEG = Math.PI / 180;
    if (!THREE) {
        return `${rotDeg.x} ${rotDeg.z} ${rotDeg.y}`;
    }
    const B = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
    const eulerPhys = new THREE.Euler(rotDeg.x * DEG, rotDeg.y * DEG, rotDeg.z * DEG, 'XYZ');
    const R_phys = new THREE.Matrix4().makeRotationFromEuler(eulerPhys);
    const BT = B.clone().transpose();
    const R_three = new THREE.Matrix4().multiplyMatrices(B, R_phys).multiply(BT);
    const eOut = new THREE.Euler().setFromRotationMatrix(R_three, 'YXZ');
    const rad2deg = 180 / Math.PI;
    return `${eOut.x * rad2deg} ${eOut.y * rad2deg} ${eOut.z * rad2deg}`;
}
