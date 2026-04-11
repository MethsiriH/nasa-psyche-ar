/**
 * AR.js area config: each poseMatrix is column-major (THREE.Matrix4.elements).
 * Translation is at indices 12,13,14.
 *
 * New learner output: poses are relative to marker 4 — marker 4’s matrix is identity
 * (origin at 4; other markers transpose from there). Legacy configs anchored at marker 0
 * are still supported for debug (translation-only offset).
 */

export type AreaConfigJson = {
    subMarkersControls: Array<{
        parameters: { type: string; barcodeValue: number };
        /**
         * AR.js pose matrix (THREE.Matrix4.elements, length 16).
         *
         * For table barcodes (1,3,4,6) we also accept a shorthand XY translation array:
         * - [x, y]  → z forced to 0, identity rotation/scale
         * - [x, y, z] → z ignored (forced to 0) for table IDs
         */
        poseMatrix: number[];
    }>;
};

/** Barcodes on the table / floor (around the base) — centroid centers the overlay on that layout vs. marker 0. */
export const AR_TABLE_BARCODE_IDS = [1, 3, 4, 6] as const;

/** Barcodes on the physical rock surface — kept for reference / future use. */
export const AR_SURFACE_BARCODE_IDS = [0, 2, 5, 7] as const;

/** Layout / debug origin barcode (identity pose in learner-exported config). */
export const AR_LAYOUT_ORIGIN_BARCODE_ID = 4;

const IDENTITY_4X4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

/**
 * Returns a normalized 4×4 matrix (length 16) when possible.
 * - Table IDs (1,3,4,6): allow shorthand [x,z] (or [x,z,y]) and force y=0 (Y is "up" in Three.js).
 * - Marker 4: if missing/short, default to identity (0,0,0 translation).
 */
export function getPoseMatrix(cfg: AreaConfigJson, barcodeValue: number): number[] | undefined {
    for (const sub of cfg.subMarkersControls) {
        if (sub.parameters?.barcodeValue !== barcodeValue) continue;
        const pm = sub.poseMatrix;
        if (Array.isArray(pm) && pm.length >= 16) return pm;

        // Accept XZ-only shorthand for table markers (Three.js: X/Z on table plane, Y up).
        if (Array.isArray(pm) && isTableBarcodeId(barcodeValue) && pm.length >= 2) {
            const x = Number(pm[0]);
            const z = Number(pm[1]);
            if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
            const out = [...IDENTITY_4X4] as number[];
            out[12] = x;
            out[13] = 0;
            out[14] = z;
            return out;
        }
    }

    // Default marker 4 to identity if absent/short (it is the reference origin).
    if (barcodeValue === AR_LAYOUT_ORIGIN_BARCODE_ID) {
        return [...IDENTITY_4X4];
    }
    return undefined;
}

/** True when marker 4 is identity (learner v2: all poses relative to marker 4). */
export function isMarker4IdentityFrame(cfg: AreaConfigJson): boolean {
    const m = getPoseMatrix(cfg, AR_LAYOUT_ORIGIN_BARCODE_ID);
    if (!m) return false;
    const id = IDENTITY_4X4;
    const eps = 0.02;
    return m.every((v, i) => Math.abs(v - id[i]) < eps);
}

export function translationFromPoseMatrix(elements: number[] | undefined): { x: number; y: number; z: number } {
    if (!elements || elements.length < 16) return { x: 0, y: 0, z: 0 };
    return { x: elements[12], y: elements[13], z: elements[14] };
}

/** Floor/table markers (1,3,4,6): treat Z as 0 by default (coplanar XY table). */
export function isTableBarcodeId(id: number): boolean {
    return (AR_TABLE_BARCODE_IDS as readonly number[]).includes(id);
}

/** Translation from pose; Y forced to 0 for table barcodes 1,3,4,6 (Three.js Y-up). */
export function translationWithTableYDefault(
    elements: number[] | undefined,
    barcodeValue: number
): { x: number; y: number; z: number } {
    const t = translationFromPoseMatrix(elements);
    if (isTableBarcodeId(barcodeValue)) {
        return { x: t.x, y: 0, z: t.z };
    }
    return t;
}

/** Average translation of the given barcode IDs (must exist in config). Table IDs use Y=0 default. */
export function averageTranslationForBarcodes(
    cfg: AreaConfigJson,
    barcodeIds: readonly number[]
): { x: number; y: number; z: number } {
    const map = new Map<number, number[]>();
    for (const sub of cfg.subMarkersControls) {
        const id = sub.parameters?.barcodeValue;
        if (typeof id !== 'number') continue;
        const m = getPoseMatrix(cfg, id);
        if (m) map.set(id, m);
    }
    let sx = 0,
        sy = 0,
        sz = 0,
        n = 0;
    for (const id of barcodeIds) {
        const m = map.get(id);
        if (!m) continue;
        const t = translationWithTableYDefault(m, id);
        sx += t.x;
        sy += t.y;
        sz += t.z;
        n++;
    }
    if (n === 0) return { x: 0, y: 0, z: 0 };
    return { x: sx / n, y: sy / n, z: sz / n };
}

/** Translation + local Z axis (column 2) from each poseMatrix — normal to the marker print. */
export type MarkerDebugEntry = {
    id: number;
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
};

export type Marker4PlaneDebugFrame = {
    /** Parent position in smoothed anchor space (0,0,0 when config is marker-4–centered). */
    t4: { x: number; y: number; z: number };
    /** Always "0 0 0" — table alignment uses translation only. */
    parentRotationStr: string;
    entries: MarkerDebugEntry[];
};

function markerDebugEntriesRawFromPoses(cfg: AreaConfigJson): MarkerDebugEntry[] {
    const list: MarkerDebugEntry[] = [];
    for (const row of cfg.subMarkersControls) {
        const id = row.parameters?.barcodeValue;
        if (typeof id !== 'number' || !row.poseMatrix || row.poseMatrix.length < 16) continue;
        const e = row.poseMatrix;
        const t = translationWithTableYDefault(e, id);
        let nx = e[8],
            ny = e[9],
            nz = e[10];
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        list.push({ id, x: t.x, y: t.y, z: t.z, nx, ny, nz });
    }
    list.sort((a, b) => a.id - b.id);
    return list;
}

/**
 * Red debug cylinders: if config has marker 4 = identity, children use pose translations directly
 * (4 at 0,0,0). Legacy marker-0 configs: parent at marker-4 translation, children shifted by −t4.
 */
export function marker4PlaneDebugFrame(cfg: AreaConfigJson): Marker4PlaneDebugFrame {
    const raw = markerDebugEntriesRawFromPoses(cfg);
    const m4 = getPoseMatrix(cfg, AR_LAYOUT_ORIGIN_BARCODE_ID);
    const t4 = translationWithTableYDefault(m4, AR_LAYOUT_ORIGIN_BARCODE_ID);

    if (isMarker4IdentityFrame(cfg)) {
        return {
            t4: { x: 0, y: 0, z: 0 },
            parentRotationStr: '0 0 0',
            entries: raw,
        };
    }

    const entries = raw.map((entry) => ({
        ...entry,
        x: entry.x - t4.x,
        y: entry.y - t4.y,
        z: entry.z - t4.z,
    }));
    return {
        t4: { x: t4.x, y: t4.y, z: t4.z },
        parentRotationStr: '0 0 0',
        entries,
    };
}

/** @deprecated Use marker4PlaneDebugFrame — entries only, no parent transform in return value. */
export function markerDebugEntriesFromConfig(cfg: AreaConfigJson): MarkerDebugEntry[] {
    return marker4PlaneDebugFrame(cfg).entries;
}
