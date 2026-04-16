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
const SURFACE_MARKER_IDS = [0, 2, 5, 7] as const;
const ALL_MARKER_IDS = [...TABLE_MARKER_IDS, ...SURFACE_MARKER_IDS] as const;
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
    for (const id of ALL_MARKER_IDS) {
        const row = markers[String(id)];
        const pose = row?.poseMatrix;
        if (!Array.isArray(pose) || pose.length < 16) continue;
        byId[id] = pose;
    }
    // Use report only when all table marker poses are available.
    for (const id of TABLE_MARKER_IDS) {
        if (!byId[id]) return null;
    }
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
    const lastSeenMsRef = useRef<Record<number, number>>({});

    // Visual constants in marker-local units (marker width ~= 1 local unit).
    const modelLift = -10.15; // vertical offset from solved center (marker-local +Y)
    const modelBack = 0.0; // no extra camera-direction push; use solved center position
    const modelOriginDown = 0.0; // avoid double-lowering; use modelLift as primary control
    const modelPitchOffsetDeg = 35; // slight tilt-back
    const modelYawOffsetDeg = 180; // global asteroid yaw correction for all marker anchors
    const modelRollOffsetDeg = 0; // left-right tilt
    const modelScaleX = 7.2; // stretch left-right
    const modelScaleY = 6.0;
    const modelScaleZ = 6.0;
    const showAsteroid = true;
    const markerPlaneOffset = 0.01; // keep red square slightly above asteroid
    const markerOverlayWidth = 1.30; // widen left/right coverage
    const markerOverlayHeight = 0.88; // reduce opposite axis stretch
    const markerOverlayShiftX = 0.03; // nudge to right
    const markerOverlayShiftZ = -0.03; // nudge to top
    const markerLostGraceMs = 700; // keep marker "visible" briefly to prevent flicker
    const anchorSwitchDebounceMs = 450; // slower anchor switching for stable asteroid rendering

    useEffect(() => {
        if (!arActive) return;
        let cancelled = false;
        (async () => {
            try {
                let byId: Record<number, number[]> = {};
                let centerFromSource: MarkerOffset | undefined;

                // Prefer surface report (contains 0..7 poses + table center) when available.
                try {
                    const sr = await fetch(`${import.meta.env.BASE_URL}surface_pair_report.json?ts=${Date.now()}`);
                    if (sr.ok) {
                        const report = await sr.json();
                        const parsed = parseTablePosesFromReport(report);
                        if (parsed) {
                            byId = parsed.byId;
                            centerFromSource = parsed.center;
                        }
                    }
                } catch {
                    // Optional file; fallback below.
                }

                // Fallback to latest recalibrated table report.
                try {
                    if (Object.keys(byId).length === 0) {
                        const rr = await fetch(`${import.meta.env.BASE_URL}table_rotation_report.json?ts=${Date.now()}`);
                        if (rr.ok) {
                            const report = await rr.json();
                            const parsed = parseTablePosesFromReport(report);
                            if (parsed) {
                                byId = parsed.byId;
                                centerFromSource = parsed.center;
                            }
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
                for (const id of ALL_MARKER_IDS) {
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
        const els = ALL_MARKER_IDS.map((id) => document.querySelector(`a-marker[type="barcode"][value="${id}"]`));
        const onFound = (id: number) => () => setVisibleIds((prev) => new Set(prev).add(id));
        const onLost = (id: number) => () =>
            setVisibleIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });

        const cleanups: Array<() => void> = [];
        for (let i = 0; i < ALL_MARKER_IDS.length; i++) {
            const id = ALL_MARKER_IDS[i];
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
            const now = Date.now();
            const next = new Set<number>();
            for (const id of ALL_MARKER_IDS) {
                const el = document.querySelector(`a-marker[type="barcode"][value="${id}"]`) as any;
                const isVisible = Boolean(el?.object3D?.visible);
                if (isVisible) {
                    lastSeenMsRef.current[id] = now;
                    next.add(id);
                    continue;
                }
                const lastSeen = lastSeenMsRef.current[id] ?? 0;
                if (now - lastSeen <= markerLostGraceMs) {
                    next.add(id);
                }
            }
            setVisibleIds((prev) => (setsEqual(prev, next) ? prev : next));
        }, 120);
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

        const next = ALL_MARKER_IDS.find((id) => visibleIds.has(id)) ?? null;

        // Debounce anchor changes a bit to avoid flicker.
        anchorHoldTimeoutRef.current = window.setTimeout(() => {
            setAnchorId(next);
            anchorHoldTimeoutRef.current = null;
        }, anchorSwitchDebounceMs);
    }, [arActive, visibleIds, anchorId]);

    // Stick to debounced anchor selection to avoid rapid reloading/flicker.
    const activeAnchorId = anchorId;

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
                                {/* Red square at marker size (2x2 inches), aligned to marker face. */}
                                <a-plane
                                    position={`${markerOverlayShiftX} ${markerPlaneOffset} ${markerOverlayShiftZ}`}
                                    rotation="-90 0 0"
                                    width={markerOverlayWidth}
                                    height={markerOverlayHeight}
                                    material="color: #ff0000; shader: standard; metalness: 0.08; roughness: 0.75; side: double; polygonOffset: true; polygonOffsetFactor: -1"
                                />

                                {/* Asteroid model: projected CENTER from solved marker poses. */}
                                {showAsteroid && activeAnchorId === id && (
                                    <a-entity position={`${c.x} ${c.y} ${c.z}`}>
                                <a-gltf-model 
                                    src="./models/AsteroidPsyche.glb" 
                                            scale={`${modelScaleX} ${modelScaleY} ${modelScaleZ}`}
                                            rotation={`${modelPitchOffsetDeg} ${modelYawOffsetDeg} ${modelRollOffsetDeg}`}
                                            position={`0 ${modelLift - modelOriginDown} ${modelBack}`}
                                        />
                                    </a-entity>
                                )}
                            </a-marker>
                                );
                            })}

                    {SURFACE_MARKER_IDS.map((id) => (
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
                            {/* Red square on each surface marker (0,2,5,7). */}
                            <a-plane
                                position={`${markerOverlayShiftX} ${markerPlaneOffset} ${markerOverlayShiftZ}`}
                                rotation="-90 0 0"
                                width={markerOverlayWidth}
                                height={markerOverlayHeight}
                                material="color: #ff0000; shader: standard; metalness: 0.08; roughness: 0.75; side: double; polygonOffset: true; polygonOffsetFactor: -1"
                            />
                            {showAsteroid && activeAnchorId === id && (
                                <a-entity position={`${(centerOffsetsById[id]?.x ?? 0)} ${(centerOffsetsById[id]?.y ?? 0)} ${(centerOffsetsById[id]?.z ?? 0)}`}>
                                    <a-gltf-model
                                        src="./models/AsteroidPsyche.glb"
                                        scale={`${modelScaleX} ${modelScaleY} ${modelScaleZ}`}
                                        rotation={`${modelPitchOffsetDeg} ${modelYawOffsetDeg} ${modelRollOffsetDeg}`}
                                        position={`0 ${modelLift - modelOriginDown} ${modelBack}`}
                                    />
                                </a-entity>
                            )}
                        </a-marker>
                    ))}
                        </a-scene>
            )}
        </div>
    );
};

export default App;