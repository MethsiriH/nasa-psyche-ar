import { useEffect, useRef, useState } from 'react';

declare global {
    namespace JSX {
        interface IntrinsicElements {
            [elemName: string]: any;
        }
    }
}

type MarkerOffset = { x: number; y: number; z: number };
type MarkerPoseSource = { byId: Record<number, number[]>; center?: MarkerOffset };

const TABLE_MARKER_IDS = [1, 3, 4, 6] as const;
const MARKER_SIZE_METERS = 0.0508; // 2 inches

function translationFromPose(elements: number[]): MarkerOffset {
    return { x: elements[12], y: elements[13], z: elements[14] };
}

function centerOffsetInMarkerLocalFromPose(elements: number[], centerGlobal: MarkerOffset): MarkerOffset {
    // poseMatrix is column-major and represents marker-local -> global transform.
    // marker-local center = R^T * (centerGlobal - markerTranslation).
    const tx = elements[12];
    const ty = elements[13];
    const tz = elements[14];
    const dx = centerGlobal.x - tx;
    const dy = centerGlobal.y - ty;
    const dz = centerGlobal.z - tz;
    return {
        x: elements[0] * dx + elements[1] * dy + elements[2] * dz,
        y: elements[4] * dx + elements[5] * dy + elements[6] * dz,
        z: elements[8] * dx + elements[9] * dy + elements[10] * dz,
    };
}

function parseTablePosesFromConfig(json: any): Record<number, number[]> {
    const controls = Array.isArray(json?.subMarkersControls) ? json.subMarkersControls : [];
    const byId: Record<number, number[]> = {};
    for (const row of controls) {
        const id = row?.parameters?.barcodeValue;
        const pose = row?.poseMatrix;
        if (typeof id !== 'number' || !Array.isArray(pose) || pose.length < 16) continue;
        byId[id] = pose;
    }
    return byId;
}

function parseTablePosesFromReport(json: any): MarkerPoseSource | null {
    const markers = json?.markers;
    if (!markers || typeof markers !== 'object') return null;
    const byId: Record<number, number[]> = {};
    for (const id of TABLE_MARKER_IDS) {
        const row = markers[String(id)];
        const pose = row?.poseMatrix;
        if (!Array.isArray(pose) || pose.length < 16) continue;
        byId[id] = pose;
    }
    // Use report only when all table marker poses are available.
    if (Object.keys(byId).length !== TABLE_MARKER_IDS.length) return null;
    const c = json?.center_1346_m;
    const center =
        c && typeof c.x === 'number' && typeof c.y === 'number' && typeof c.z === 'number'
            ? { x: c.x, y: c.y, z: c.z }
            : undefined;
    return { byId, center };
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) {
        if (!b.has(v)) return false;
    }
    return true;
}

const App = () => {
    const [arActive, setArActive] = useState(false);
    const [centerOffsetsById, setCenterOffsetsById] = useState<Record<number, MarkerOffset>>({});
    const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set());
    const [anchorId, setAnchorId] = useState<number | null>(null);
    const anchorHoldTimeoutRef = useRef<number | null>(null);

    // Visual constants in marker-local units (marker width ~= 1 local unit).
    const modelLift = -2.12; // marker-local +Y (up)
    const modelBack = -1.2; // marker-local -Z (away from camera)
    const modelOriginDown = 1.5; // move mesh down without changing scale
    const showAsteroid = false; // set true to re-enable asteroid model
    const markerPlaneOffset = 0.0; // keep exactly on marker plane for best alignment
    const markerOverlaySize = 1.0; // 2 inches in marker-local units
    const markerOverlayWidth = markerOverlaySize * 1.8;
    const markerOverlayHeight = markerOverlaySize;
    const markerOverlayDepth = markerOverlaySize;
    const markerOverlayShiftX = 0.0; // center on marker
    const markerOverlayShiftZ = 0.0; // center on marker

    useEffect(() => {
        if (!arActive) return;
        let cancelled = false;
        (async () => {
            try {
                let byId: Record<number, number[]> = {};
                let centerFromSource: MarkerOffset | undefined;

                // Prefer latest recalibrated table report when available.
                try {
                    const rr = await fetch(`${import.meta.env.BASE_URL}table_rotation_report.json?ts=${Date.now()}`);
                    if (rr.ok) {
                        const report = await rr.json();
                        const parsed = parseTablePosesFromReport(report);
                        if (parsed) {
                            byId = parsed.byId;
                            centerFromSource = parsed.center;
                        }
                    }
                } catch {
                    // Optional file; fallback below.
                }

                if (Object.keys(byId).length === 0) {
                    const res = await fetch(`${import.meta.env.BASE_URL}config.json`);
                    const json = await res.json();
                    byId = parseTablePosesFromConfig(json);
                }

                const tablePoses = TABLE_MARKER_IDS.map((id) => byId[id]).filter(Boolean) as number[][];
                if (tablePoses.length === 0) {
                    if (!cancelled) setCenterOffsetsById({});
                    return;
                }

                // Rectangle center / centroid in global config frame.
                const tablePts = tablePoses.map((pose) => translationFromPose(pose));
                const centerGlobal: MarkerOffset =
                    centerFromSource ?? {
                        x: tablePts.reduce((s, p) => s + p.x, 0) / tablePts.length,
                        y: tablePts.reduce((s, p) => s + p.y, 0) / tablePts.length,
                        z: tablePts.reduce((s, p) => s + p.z, 0) / tablePts.length,
                    };

                const next: Record<number, MarkerOffset> = {};
                for (const id of TABLE_MARKER_IDS) {
                    const pose = byId[id];
                    if (!pose) continue;
                    const offM = centerOffsetInMarkerLocalFromPose(pose, centerGlobal);
                    // A-Frame <a-marker size=...> uses marker-local units (1 unit == marker width).
                    // Convert meter offsets from config into marker-local units.
                    next[id] = {
                        x: offM.x / MARKER_SIZE_METERS,
                        y: offM.y / MARKER_SIZE_METERS,
                        z: offM.z / MARKER_SIZE_METERS,
                    };
                }
                if (!cancelled) setCenterOffsetsById(next);
            } catch {
                if (!cancelled) setCenterOffsetsById({});
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [arActive]);

    // Track which barcode markers are currently visible, so we can choose ONE anchor for CENTER.
    useEffect(() => {
        if (!arActive) return;
        const els = TABLE_MARKER_IDS.map((id) => document.querySelector(`a-marker[type="barcode"][value="${id}"]`));
        const onFound = (id: number) => () => setVisibleIds((prev) => new Set(prev).add(id));
        const onLost = (id: number) => () =>
            setVisibleIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });

        const cleanups: Array<() => void> = [];
        for (let i = 0; i < TABLE_MARKER_IDS.length; i++) {
            const id = TABLE_MARKER_IDS[i];
            const el = els[i] as any;
            if (!el) continue;
            const f = onFound(id);
            const l = onLost(id);
            el.addEventListener('markerFound', f);
            el.addEventListener('markerLost', l);
            cleanups.push(() => {
                el.removeEventListener('markerFound', f);
                el.removeEventListener('markerLost', l);
            });
        }
        return () => cleanups.forEach((fn) => fn());
    }, [arActive]);

    // Poll actual marker visibility as a fallback (some devices miss markerFound/lost events).
    useEffect(() => {
        if (!arActive) return;
        const interval = window.setInterval(() => {
            const next = new Set<number>();
            for (const id of TABLE_MARKER_IDS) {
                const el = document.querySelector(`a-marker[type="barcode"][value="${id}"]`) as any;
                if (el?.object3D?.visible) next.add(id);
            }
            setVisibleIds((prev) => (setsEqual(prev, next) ? prev : next));
        }, 100);
        return () => window.clearInterval(interval);
    }, [arActive]);

    // Stabilize anchor selection to avoid rapid switching/jitter.
    useEffect(() => {
        if (!arActive) return;

        if (anchorHoldTimeoutRef.current !== null) {
            window.clearTimeout(anchorHoldTimeoutRef.current);
            anchorHoldTimeoutRef.current = null;
        }

        // Prefer 4 when available (table origin / most stable reference).
        if (visibleIds.has(4)) {
            setAnchorId(4);
            return;
        }

        // Keep current anchor if it's still visible.
        if (anchorId !== null && visibleIds.has(anchorId)) return;

        const next = TABLE_MARKER_IDS.find((id) => visibleIds.has(id)) ?? null;

        // Debounce anchor changes a bit to avoid flicker.
        anchorHoldTimeoutRef.current = window.setTimeout(() => {
            setAnchorId(next);
            anchorHoldTimeoutRef.current = null;
        }, 250);
    }, [arActive, visibleIds, anchorId]);

    // Immediate fallback so a single visible marker can render without waiting for debounce/state lag.
    const activeAnchorId = (() => {
        if (anchorId !== null && visibleIds.has(anchorId)) return anchorId;
        if (visibleIds.has(4)) return 4;
        for (const id of TABLE_MARKER_IDS) {
            if (visibleIds.has(id)) return id;
        }
        return null;
    })();

    return (
        <div style={{ width: '100vw', height: '100vh', margin: 0, overflow: 'hidden' }}>
            {!arActive ? (
                <div style={{ color: 'white', textAlign: 'center', paddingTop: '40vh' }}>
                    <h1>NASA Psyche AR</h1>
                    <button style={{ padding: '15px 30px', fontSize: '18px', cursor: 'pointer' }} onClick={() => setArActive(true)}>
                        START AR SCANNER
                        </button>
                    </div>
            ) : (
                        <a-scene
                            embedded 
                    style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}
                    arjs="sourceType: webcam; detectionMode: mono_and_matrix; matrixCodeType: 3x3_HAMMING63; patternRatio: 0.52;"
                            vr-mode-ui="enabled: false"
                    renderer="logarithmicDepthBuffer: true;"
                        >
                            <a-camera position="0 0 0" look-controls="enabled: false"></a-camera>
                            
                    {TABLE_MARKER_IDS.map((id) => {
                        const c = centerOffsetsById[id] ?? { x: 0, y: 0, z: 0 };
                                            return (
                            <a-marker
                                key={id}
                                type="barcode"
                                value={id}
                                size={MARKER_SIZE_METERS}
                                smooth="true"
                                smoothCount="18"
                                smoothTolerance="0.008"
                                smoothThreshold="4"
                            >
                                {/* Red cube overlay, centered on marker. */}
                                <a-box
                                    position={`${markerOverlayShiftX} ${markerPlaneOffset + markerOverlayDepth / 2} ${markerOverlayShiftZ}`}
                                    rotation="-90 0 0"
                                    width={markerOverlayWidth}
                                    height={markerOverlayDepth}
                                    depth={markerOverlayHeight}
                                    material="color: #ff0000; shader: standard; metalness: 0.08; roughness: 0.75; side: double"
                                />

                                {/* Orange center square at marker size (2x2 inches). */}
                                {activeAnchorId === id && (
                                    <a-plane
                                        position={`${c.x} ${c.y + markerPlaneOffset} ${c.z}`}
                                        rotation="-90 0 0"
                                        width="1"
                                        height="1"
                                        material="color: #ff8c00; shader: standard; metalness: 0.08; roughness: 0.7; side: double; polygonOffset: true; polygonOffsetFactor: -1"
                                    />
                                )}

                                {/* Asteroid model: projected CENTER from config pose */}
                                {showAsteroid && activeAnchorId === id && (
                                    <a-entity position={`${c.x} ${c.y + modelLift} ${c.z + modelBack}`}>
                                <a-gltf-model 
                                    src="./models/AsteroidPsyche.glb" 
                                            scale="6.0 6.0 6.0"
                                            position={`0 ${-modelOriginDown} 0`}
                                        />
                                    </a-entity>
                                )}
                            </a-marker>
                                );
                            })}
                        </a-scene>
            )}
        </div>
    );
};

export default App;