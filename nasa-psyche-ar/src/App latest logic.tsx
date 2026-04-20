/**
 * NASA Psyche AR — Web/AR rover exploration experience.
 * Uses React + A-Frame for 3D, Rust/WASM for collision and movement.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import MODE_CONFIG, { Difficulty } from './modeConfig';
// @ts-ignore
import init, { start_ar_session, load_collision_mesh, move_rover_on_asteroid, get_surface_point_in_direction } from '../rust_engine/pkg/rust_engine';

/** Returns a uniformly distributed random unit vector on the sphere via rejection sampling. */
const randomUnitVector = (): [number, number, number] => {
    let x: number, y: number, z: number, len: number;
    do {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
        len = Math.sqrt(x * x + y * y + z * z);
    } while (len === 0 || len > 1);
    return [x / len, y / len, z / len];
};

const MOVE_INTERVAL = 33; // ms between movement ticks (~30 fps)
const MAX_ENERGY = 50;
/** AR rover moves at a smaller step size than web since the marker-anchored world is smaller. */
const AR_ROVER_SPEED_SCALE = 0.4;
/** Deterministic initial rover spawn direction in asteroid-local space for AR. */
const AR_ROVER_START_DIRECTION: [number, number, number] = [0, 1, 0];

/** Pushes a point radially outward from the asteroid center by `offset` so the rover hugs the surface without clipping. */
const pushOutFromCenter = (x: number, y: number, z: number, offset: number): [number, number, number] => {
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) return [x, y, z];
    return [
        x + (x / len) * offset,
        y + (y / len) * offset,
        z + (z / len) * offset,
    ];
};

/**
 * AR alignment tunables — live-editable through the AR calibration panel and persisted in
 * localStorage. Defaults reflect the values baked into the prototype; use the in-AR sliders
 * to drive these until the virtual asteroid matches the physical asteroid, then copy the
 * resulting JSON back into AR_CALIBRATION_DEFAULTS to ship them.
 */
type ArCalibration = {
    modelLift: number;
    modelBack: number;
    modelYawOffsetDeg: number;
    modelPitchOffsetDeg: number;
    modelRollOffsetDeg: number;
    modelScaleX: number;
    modelScaleY: number;
    modelScaleZ: number;
    sampleScaleFr: number;
    /** When true, changing Lift (Y) multiplies X/Y/Z scale so apparent size stays ~constant (deeper → bigger). */
    compensateScaleWithLift: boolean;
    /** Depth proxy = pivot − lift (marker units); default 0 matches “more negative Y = farther → scale up”. */
    liftDistancePivot: number;
};

/** Generates star data with uniform random distribution across a surrounding sphere. */
const generateStars = (count: number) => {
    const COLORS = ['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF', '#00d4ff', '#7b2cbf'];
    const RADIUS = 120;
    // Simple seeded LCG for fully deterministic placement and variation
    let seed = 42;
    const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };
    return Array.from({ length: count }, (_, i) => {
        const phi = Math.acos(2 * rand() - 1);       // uniform latitude (0..π)
        const theta = 2 * Math.PI * rand();             // uniform longitude (0..2π)
        const radius = RADIUS + (rand() - 0.5) * 24;    // ±12 units of depth jitter
        const x = Math.sin(phi) * Math.cos(theta) * radius;
        const yPos = Math.cos(phi) * radius;
        const z = Math.sin(phi) * Math.sin(theta) * radius;
        return {
            id: i,
            pos: `${x.toFixed(2)} ${yPos.toFixed(2)} ${z.toFixed(2)}`,
            radius: 0.3 + rand() * 0.4,
            color: COLORS[Math.floor(rand() * COLORS.length)],
            opacity: 0.7 + rand() * 0.3,
            dur: Math.round(2000 + rand() * 3000),
            delay: Math.round(rand() * 2000),
        };
    });
};

const STARS = generateStars(250);

/** World-space directions for raycasting waypoint positions on the asteroid surface. */
// const WAYPOINT_DIRECTIONS: [number, number, number][] = [
//     [0.707, 0, 0.707], [-0.707, 0.2, 0.707], [0, 0.707, 0.707], [0, -0.707, 0.707],
//     [0.707, 0.707, 0], [-0.707, 0.5, -0.5], [0, 0, -1], [0.5, -0.707, -0.5],
// ];

const INTRO_CONTENT: Record<string, { welcome: string; description: string }> = {
    easy: {
        welcome: 'Welcome to Story Mode',
        description: 'Explore the surface of asteroid Psyche with complete freedom. Pilot the rover across the terrain and drive over samples to collect them. If you ever get lost, follow the indicator arrow to the nearest sample.',
    },
    normal: {
        welcome: 'Welcome to Standard Mode',
        description: "Explore Psyche with the energy system in play. Your rover's battery drains as you roam — collect samples efficiently before power runs out. Follow the indicator arrow if you lose track of your next sample. The mission ends when you collect all 20 samples or run out of energy.",
    },
    hard: {
        welcome: 'Welcome to Challenge Mode',
        description: "Psyche is at its most unforgiving. Energy drains your battery, and craters larger than the rover are scattered across the surface — driving into one cuts your speed in half and drains energy faster. Navigate carefully, collect samples quickly, and use the indicator arrow wisely. The mission ends when you collect all 20 samples or run out of energy.",
    },
};
const OBSTACLE_DIRECTIONS: [number, number, number, number][] = [
    [0.6849, 2.2127, -1.16, 1.15],
    [-0.6158, 2.7743, 0.4824, .8],
    [1.68, 0.35, 2.861, .26],
    [2.9, 1.65, 0.633, 0.27],
    [3.3426, -0.4972, 0.08, 0.35],
    [1.9917, 2.33, 1.4612, 0.24],
    [-3.5883, -0.1327, -.01, .35],
    [-0.4975, -0.5, 2.7357, 0.24],
    [-1.21, -1.4, 1.6656, 0.35],
];

type SampleModel = 'crystal' | 'ore' | 'rock';

/** ------------------------------------------------------------------
 * AR calibration types & helpers (marker pose-based anchoring).
 * Pulled from the calibrated AR prototype to keep scale/orientation
 * consistent between table and surface markers.
 * ------------------------------------------------------------------ */
type MarkerOffset = { x: number; y: number; z: number };
type MarkerPoseSource = { byId: Record<number, number[]>; center?: MarkerOffset };
const TABLE_MARKER_IDS = [1, 3, 4, 6] as const;
const SURFACE_MARKER_IDS = [0, 2, 5, 7] as const;
const ALL_MARKER_IDS = [...TABLE_MARKER_IDS, ...SURFACE_MARKER_IDS] as const;
const MARKER_SIZE_METERS = 0.0508; // 2 inches printed barcode

/**
 * 3D-printed physical asteroid (meters), same axis convention as public/surface_pair_report.json
 * ("three.js Y-up; table flattened to Y=0; surface markers constrained to +Y").
 * Mesh spans: npm run ar:collision-bbox (scripts/compute-collision-mesh-bbox.mjs).
 */
const PHYSICAL_ASTEROID_BBOX_M = { x: 0.61, y: 0.524, z: 0.432 } as const;
/** AABB edge lengths of AsteroidPsyche_Collision.glb after Rust scale 2.5 + offset (physics space). */
const COLLISION_MESH_PHYSICS_SPAN = { x: 7.407302185893059, y: 5.180009913165122, z: 6.379854867700487 } as const;
/** Legacy mean scale (7.2/6/6) — only used to rescale lift when applying physical match. */
const LEGACY_AR_MODEL_SCALE_REF = (7.2 + 6.0 + 6.0) / 3;

/** Uniform modelScale (X=Y=Z) so WASM stays isotropic; least-squares fit of bbox edges to meters. */
function computeUniformScaleForPhysicalAsteroid(): number {
    const sx = COLLISION_MESH_PHYSICS_SPAN.x;
    const sy = COLLISION_MESH_PHYSICS_SPAN.y;
    const sz = COLLISION_MESH_PHYSICS_SPAN.z;
    const px = PHYSICAL_ASTEROID_BBOX_M.x;
    const py = PHYSICAL_ASTEROID_BBOX_M.y;
    const pz = PHYSICAL_ASTEROID_BBOX_M.z;
    const dot = sx * px + sy * py + sz * pz;
    const normSq = sx * sx + sy * sy + sz * sz;
    return dot / (MARKER_SIZE_METERS * normSq);
}

const AR_PHYSICAL_MATCH_UNIFORM_SCALE = computeUniformScaleForPhysicalAsteroid();

const AR_CALIBRATION_DEFAULTS: ArCalibration = {
    modelLift: (-30.15 * AR_PHYSICAL_MATCH_UNIFORM_SCALE) / LEGACY_AR_MODEL_SCALE_REF,
    modelBack: 0.0,
    modelYawOffsetDeg: 180,
    modelPitchOffsetDeg: 35,
    modelRollOffsetDeg: 0,
    modelScaleX: AR_PHYSICAL_MATCH_UNIFORM_SCALE,
    modelScaleY: AR_PHYSICAL_MATCH_UNIFORM_SCALE,
    modelScaleZ: AR_PHYSICAL_MATCH_UNIFORM_SCALE,
    sampleScaleFr: 0.20,
    compensateScaleWithLift: false,
    liftDistancePivot: 0,
};

// v3: physical 610×524×432 mm ↔ collision mesh bbox; 2" calibration cube (1 marker unit).
const AR_CALIBRATION_STORAGE_KEY = 'nasa-psyche-ar-calibration-v3';

const loadArCalibration = (): ArCalibration => {
    try {
        const raw = localStorage.getItem(AR_CALIBRATION_STORAGE_KEY);
        if (!raw) return { ...AR_CALIBRATION_DEFAULTS };
        const parsed = JSON.parse(raw) as Partial<ArCalibration>;
        return { ...AR_CALIBRATION_DEFAULTS, ...parsed };
    } catch {
        return { ...AR_CALIBRATION_DEFAULTS };
    }
};

/** Positive “depth” proxy for lift compensation; pivot − lift, floored so we never divide by ~0. */
function liftDepthForScreenCompensation(pivot: number, lift: number): number {
    return Math.max(0.25, pivot - lift);
}

function translationFromPose(elements: number[]): MarkerOffset {
    return { x: elements[12], y: elements[13], z: elements[14] };
}

/** Column-major pose inverse-rotate to express the global center in a marker's local frame. */
function centerOffsetInMarkerLocalFromPose(elements: number[], centerGlobal: MarkerOffset): MarkerOffset {
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

function parsePosesFromConfig(json: any): Record<number, number[]> {
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

/** Reads public/surface_pair_report.json (or table_rotation_report.json) marker poses. */
function parsePosesFromReport(json: any): MarkerPoseSource | null {
    const markers = json?.markers;
    if (!markers || typeof markers !== 'object') return null;
    const byId: Record<number, number[]> = {};
    for (const id of ALL_MARKER_IDS) {
        const row = markers[String(id)];
        const pose = row?.poseMatrix;
        if (!Array.isArray(pose) || pose.length < 16) continue;
        byId[id] = pose;
    }
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
    const [gameState, setGameState] = useState('MENU');
    const [score, setScore] = useState(0);
    const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal');
    const modeCfg = MODE_CONFIG[difficulty as Difficulty];
    // Samples (collectibles) and Obstacles
    const [samples, setSamples] = useState<{ id: string; x: number; y: number; z: number; model: SampleModel; rotation: string }[]>([]);
    const samplesRef = useRef<typeof samples>([]);
    samplesRef.current = samples;
    const [samplesCollected, setSamplesCollected] = useState(0);

    const [obstacles, setObstacles] = useState<{ id: string; x: number; y: number; z: number; radius: number}[]>([]);
    const obstaclesRef = useRef<typeof obstacles>([]);
    obstaclesRef.current = obstacles;

    // Energy meter (0..100) - skeleton only
    const [energy, setEnergy] = useState(MAX_ENERGY);
    const [showDifficulty, setShowDifficulty] = useState(false);
    const [showCredits, setShowCredits] = useState(false);
    const [showIntroPopup, setShowIntroPopup] = useState(false);
    const [introPopupCanClose, setIntroPopupCanClose] = useState(false);
    const showIntroPopupRef = useRef(false);
    showIntroPopupRef.current = showIntroPopup;
    const introLockoutTimerRef = useRef<number | null>(null);
    const [showEndScreen, setShowEndScreen] = useState(false);
    const [endReason, setEndReason] = useState<'complete' | 'energy'>('complete');
    const [energyBonus, setEnergyBonus] = useState(0);

    // Centralized difficulty configuration placeholder.

    // const difficultyConfig: Record<string, any> = {
    //     easy: { spawnCount: 4, scoreMultiplier: 0.8 },
    //     normal: { spawnCount: 6, scoreMultiplier: 1.0 },
    //     hard: { spawnCount: 8, scoreMultiplier: 1.25 },
    // };
    const [scanPrompt, setScanPrompt] = useState(true);
    const [meshLoaded, setMeshLoaded] = useState(false);
    const [roverReady, setRoverReady] = useState(false);
    const lastDirectionRef = useRef<[number, number]>([0, 1]);
    const keysHeld = useRef(new Set<string>());
    const dpadInputRef = useRef<[number, number]>([0, 0]);
    const moveLoopId = useRef<number | null>(null);
    const lastMoveTime = useRef(0);
    const prevCamUp = useRef<any>(null);
    const energyRef = useRef(MAX_ENERGY);
    energyRef.current = energy;
    const wasInObstacleRef = useRef(false);
    const endTriggeredRef = useRef(false);
    const modeCfgRef = useRef(modeCfg);
    modeCfgRef.current = modeCfg;
    // Keyboard navigation
    const playBtnRef = useRef<HTMLButtonElement | null>(null);
    const arBtnRef = useRef<HTMLButtonElement | null>(null);
    const creditsBtnRef = useRef<HTMLButtonElement | null>(null);
    const diffBtnRefs = [useRef<HTMLButtonElement | null>(null), useRef<HTMLButtonElement | null>(null), useRef<HTMLButtonElement | null>(null)];
    const [waypointPopup, setWaypointPopup] = useState<{ title: string; body?: string; image?: string; } | null>(null);

    /** When true, the difficulty picker will launch the AR Experience instead of the web game. */
    const [launchInAr, setLaunchInAr] = useState(false);

    /** ---------- AR calibration + scale constants (pulled from calibrated AR build) ---------- */
    const [centerOffsetsById, setCenterOffsetsById] = useState<Record<number, MarkerOffset>>({});
    const [arVisibleIds, setArVisibleIds] = useState<Set<number>>(new Set());
    const [arAnchorId, setArAnchorId] = useState<number | null>(null);
    const arAnchorHoldTimeoutRef = useRef<number | null>(null);
    const arLastSeenMsRef = useRef<Record<number, number>>({});

    // Parent entity transform that places the asteroid near the table marker.
    const [arCalibration, setArCalibration] = useState<ArCalibration>(() => loadArCalibration());
    const [showArCalibrationPanel, setShowArCalibrationPanel] = useState(false);
    // Persist any slider change so the next session starts with the tuned values.
    useEffect(() => {
        try {
            localStorage.setItem(AR_CALIBRATION_STORAGE_KEY, JSON.stringify(arCalibration));
        } catch {
            /* storage may be disabled — not fatal */
        }
    }, [arCalibration]);
    const updateArCalibration = useCallback((patch: Partial<ArCalibration>) => {
        setArCalibration((prev) => ({ ...prev, ...patch }));
    }, []);
    const {
        modelLift,
        modelBack,
        modelYawOffsetDeg,
        modelPitchOffsetDeg,
        modelRollOffsetDeg,
        modelScaleX,
        modelScaleY,
        modelScaleZ,
        sampleScaleFr,
        compensateScaleWithLift,
        liftDistancePivot,
    } = arCalibration;
    const showArAsteroid = true;
    /**
     * Toggles the red calibration reference cube drawn on every detected marker.
     * Purely a visual check — has no physics, no parent-scale transforms, and is a
     * direct child of <a-marker>. Use it to confirm (a) AR.js is loading, (b) markers
     * are being tracked, and (c) your calibration math lines the cube up with the real marker.
     */
    const showCalibrationCube = true;
    /**
     * Toggles a bright green debug sphere co-located with the AR rover. Great for verifying
     * whether the rover's computed position is actually on the asteroid surface when the
     * rover model itself is hard to see/orient.
     */
    const showArRoverDebugSphere = false;

    /** Persisted across anchor switches so the rover stays on the asteroid even when the AR parent remounts. */
    const roverPosRef = useRef<{ x: number; y: number; z: number } | null>(null);

    // Calibration cube: 1 marker unit = printed marker width = 2" (MARKER_SIZE_METERS) on each edge.
    const MARKER_CUBE_REF_SIZE = 1.0;
    const MARKER_CUBE_WIDTH_RATIO = 1.0;
    const MARKER_CUBE_HEIGHT_RATIO = 1.0;
    const MARKER_CUBE_DEPTH_RATIO = 1.0;
    const markerPlaneOffset = 0.0;
    const markerOverlaySize = MARKER_CUBE_REF_SIZE;
    const markerOverlayWidth = markerOverlaySize * MARKER_CUBE_WIDTH_RATIO;
    const markerOverlayHeight = markerOverlaySize * MARKER_CUBE_HEIGHT_RATIO;
    const markerOverlayDepth = markerOverlaySize * MARKER_CUBE_DEPTH_RATIO;
    const markerOverlayShiftX = 0.0;
    const markerOverlayShiftZ = 0.0;

    // Interior sizes expressed as fractions of the reference cube edge.
    const AR_SAMPLE_SCALE_FR = sampleScaleFr; // GLB sample scale in asteroid-local space (live-tuned)
    const AR_ARROW_CONE_HEIGHT_FR = 0.015;
    const AR_ARROW_CONE_RADIUS_FR = 0.008;
    const AR_ARROW_CYL_RADIUS_FR = 0.002;
    const AR_ARROW_CYL_HEIGHT_FR = 0.018;
    const AR_ARROW_CONE_OFFSET_Y_FR = 0.016;
    const AR_ARROW_CYL_OFFSET_Y_FR = 0.003;
    const AR_ARROW_ORBIT_RADIUS_FR = 0.2 / MARKER_CUBE_WIDTH_RATIO;
    const AR_ARROW_NORMAL_OFFSET_FR = 0.04;
    const AR_COLLECTION_RADIUS_FR = 0.25;
    const AR_ROVER_SURFACE_OFFSET_FR = 0.06;
    const AR_ROVER_DESIRED_SCALE_FR = 5.0;

    const arSampleScale = markerOverlaySize * AR_SAMPLE_SCALE_FR;
    const arSampleScaleStr = `${arSampleScale} ${arSampleScale} ${arSampleScale}`;
    const arObstacleParentScaleMean = (modelScaleX + modelScaleY + modelScaleZ) / 3;
    const arArrowConeHeight = markerOverlaySize * AR_ARROW_CONE_HEIGHT_FR;
    const arArrowConeRadiusBottom = markerOverlaySize * AR_ARROW_CONE_RADIUS_FR;
    const arArrowCylRadius = markerOverlaySize * AR_ARROW_CYL_RADIUS_FR;
    const arArrowCylHeight = markerOverlaySize * AR_ARROW_CYL_HEIGHT_FR;
    const arArrowConeY = markerOverlaySize * AR_ARROW_CONE_OFFSET_Y_FR;
    const arArrowCylY = markerOverlaySize * AR_ARROW_CYL_OFFSET_Y_FR;
    const arArrowOrbitRadius = markerOverlayWidth * AR_ARROW_ORBIT_RADIUS_FR;
    const arArrowNormalOffset = markerOverlaySize * AR_ARROW_NORMAL_OFFSET_FR;
    const arCollectionRadius = markerOverlaySize * AR_COLLECTION_RADIUS_FR;
    const arSurfaceOffset = markerOverlaySize * AR_ROVER_SURFACE_OFFSET_FR;
    const arRoverDesiredScale = markerOverlaySize * AR_ROVER_DESIRED_SCALE_FR;
    // Compensate rover scale so it renders at a consistent world size regardless of the parent's non-uniform scale.
    const arRoverScaleStr = `${arRoverDesiredScale / modelScaleX} ${arRoverDesiredScale / modelScaleY} ${arRoverDesiredScale / modelScaleZ}`;

    /**
     * Visual asteroid GLB must use the same local transform Rust applies when building the collision
     * mesh (rust_engine/src/lib.rs: scale_factor 2.5, offset -3.75 / -2.2 / 3.22). WASM positions
     * for rover, samples, and obstacles are already in that baked space.
     *
     * In AR we deliberately render AsteroidPsyche_Collision.glb (the LOW-POLY mesh that Rust
     * raycasts against) rather than AsteroidPsyche.glb. That guarantees the visual surface and
     * the physics surface are THE SAME geometry — no vertex-drift between high-poly art and
     * low-poly collider — so the rover, samples, and obstacles sit exactly on what the user sees.
     */
    const arAsteroidGltfScale = '2.5 2.5 2.5';
    const arAsteroidGltfPosition = '-3.75 -2.2 3.22';
    const arAsteroidModelSrc = './models/AsteroidPsyche_Collision.glb';
    const markerLostGraceMs = 700;
    const anchorSwitchDebounceMs = 450;

    /** Initialize WASM and load asteroid collision mesh from GLB. */
    useEffect(() => {
        const initRust = async () => {
            try {
                await init();
                console.log("✅ WASM initialized");
                const response = await fetch('./models/AsteroidPsyche_Collision.glb');
                const arrayBuffer = await response.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);

                console.log(`📦 Loading collision mesh: ${bytes.length} bytes`);
                await load_collision_mesh(bytes);
                console.log("✅ Collision mesh loaded!");
                setMeshLoaded(true);
            } catch (e) {
                console.error("❌ Failed to initialize:", e);
            }
        };

        initRust();
    }, []);

    const closeIntroPopup = () => {
        setShowIntroPopup(false);
        setIntroPopupCanClose(false);
    };

    const returnToMenu = () => {
        setGameState('MENU');
        setShowEndScreen(false);
        setShowIntroPopup(false);
        setIntroPopupCanClose(false);
        setWaypointPopup(null);
        setSamplesCollected(0);
        setScore(0);
        energyRef.current = MAX_ENERGY;
        setEnergy(MAX_ENERGY);
        wasInObstacleRef.current = false;
        endTriggeredRef.current = false;
        setEnergyBonus(0);
        popupIndexRef.current = 0;
        setLaunchInAr(false);
        setArAnchorId(null);
        setArVisibleIds(new Set());
        roverPosRef.current = null;
    };

    const handleStart = async (mode: string, chosenDifficulty?: 'easy' | 'normal' | 'hard') => {
        if (chosenDifficulty) setDifficulty(chosenDifficulty);

        if (mode === 'web_game') {
            console.log("Starting WEB GAME MODE", chosenDifficulty);
            setGameState('WEB_GAME');
            if (introLockoutTimerRef.current) clearTimeout(introLockoutTimerRef.current);
            setShowIntroPopup(true);
            setIntroPopupCanClose(false);
            introLockoutTimerRef.current = window.setTimeout(() => setIntroPopupCanClose(true), 3500);
        } else if (mode === 'ar') {
            console.log("Starting AR MODE", chosenDifficulty);
            setGameState('AR_MODE');
            // AR Experience launched from the Launch flow uses the same intro/briefing as web.
            if (chosenDifficulty !== undefined) {
                if (introLockoutTimerRef.current) clearTimeout(introLockoutTimerRef.current);
                setShowIntroPopup(true);
                setIntroPopupCanClose(false);
                introLockoutTimerRef.current = window.setTimeout(() => setIntroPopupCanClose(true), 3500);
            } else {
                setShowIntroPopup(false);
                setIntroPopupCanClose(false);
            }
            try {
                await start_ar_session(mode);
            } catch (e) {
                console.error("Failed to start AR session", e);
                // Continue anyway to show AR scene
            }
        }
    };

    /** Builds right/up/normal frame at position using parallel transport for smooth camera orientation. */
    const getCameraFrame = (px: number, py: number, pz: number) => {
        const THREE = (window as any).THREE;
        const normal = new THREE.Vector3(px, py, pz).normalize();

        let up: any;
        if (prevCamUp.current) {
            up = prevCamUp.current.clone();
            up.addScaledVector(normal, -up.dot(normal));

            if (up.lengthSq() < 0.0001) {
                const ref = new THREE.Vector3(0, 1, 0);
                if (Math.abs(normal.dot(ref)) > 0.9) ref.set(0, 0, -1);
                const tmpRight = new THREE.Vector3().crossVectors(ref, normal).normalize();
                up = new THREE.Vector3().crossVectors(normal, tmpRight);
            }
            up.normalize();
        } else {
            const ref = new THREE.Vector3(0, 1, 0);
            if (Math.abs(normal.dot(ref)) > 0.9) ref.set(0, 0, -1);
            const right = new THREE.Vector3().crossVectors(ref, normal).normalize();
            up = new THREE.Vector3().crossVectors(normal, right);
        }

        const right = new THREE.Vector3().crossVectors(up, normal).normalize();
        up = new THREE.Vector3().crossVectors(normal, right).normalize();

        prevCamUp.current = up.clone();
        return { right, up, normal };
    };

    const popups = [
        {
            title: 'One Sample Collected!',
            body: `
            Psyche is an asteroid between Mars and Jupiter and the name of a NASA space mission to visit that asteroid, led by ASU. Psyche is the first mission to a world likely made largely of metal rather than rock or ice.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Two Samples Collected',
            body: `
            Judging from data obtained by Earth-based radar and optical telescopes, scientists hypothesize that the asteroid Psyche could be part of the metal-rich interior of a planetesimal that lost its outer rocky shell.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Three Samples Collected',
            body: `
            Previously, the consensus of the science community was that asteroid Psyche was almost entirely metal. New data on density, radar properties, and spectral signatures indicate that the asteroid is possibly a mixed metal and rock world.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Four Samples Collected',
            body: `
            Humans can’t bore a path to Earth’s metal core – or the cores of the other rocky planets – so visiting Psyche could provide a one-of-a-kind window into the history of violent collisions and accumulation of matter that created planets like our own.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Five Samples Collected',
            body: `
            While rocks on Mars, Venus, and Earth are flush with iron oxides, Psyche’s surface – at least when studied from afar – doesn’t seem to feature much of these chemical compounds.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Six Samples Collected',
            body: `
            If the asteroid is leftover core material from a planetary building block, scientists look forward to learning how its history resembles and diverges from that of the rocky planets.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Seven Samples Collected',
            body: `
            The surface gravity on Psyche is much less than on Earth, and even less than on the Moon. On Psyche, lifting a car would feel as light as lifting a big dog on Earth!
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Eight Samples Collected',
            body: `
            The Psyche spacecraft includes three instruments: a magnetometer, multispectral imager, and gamma ray and neutron spectrometer.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Nine Samples Collected',
            body: `
            Psyche’s magnetometer will look for evidence of an ancient magnetic field at the asteroid Psyche. A residual magnetic field would be strong evidence the asteroid formed from the core of a planetary body.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Ten Samples Collected',
            body: `
            The orbiter’s gamma-ray and neutron spectrometer will help scientists determine the chemical elements that make up the asteroid.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Eleven Samples Collected',
            body: `
            The spacecraft’s multispectral imager will provide information about the mineral composition of Psyche as well as its topography. 
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Twelve Samples Collected',
            body: `
            By analyzing the radio waves the spacecraft communicates with, scientists can measure how the asteroid Psyche affects the spacecraft’s orbit. From that information, scientists can determine the asteroid’s rotation, mass, and gravity field.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Thirteen Samples Collected',
            body: `
            The Psyche spacecraft will use a special kind of super-efficient propulsion system for the first time beyond the Moon.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Fourteen Samples Collected',
            body: `
            Powered by Hall-effect thrusters, Psyche’s solar electric propulsion system harnesses energy from large solar arrays to create electric and magnetic fields.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Fifteen Samples Collected',
            body: `
            The electric and magnetic fields accelerate and expel charged atoms, or ions, of a propellant called xenon. The plasma will emit a sci-fi-like blue glow.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Sixteen Samples Collected',
            body: `
            Each of Psyche’s four thrusters, which will operate only one at a time, exert at most the same amount of force that one AA battery would exert on the palm of your hand.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Seventeen Samples Collected',
            body: `
            Over time, in the frictionless void of space, the spacecraft will slowly and continuously accelerate.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Eighteen Samples Collected',
            body: `
            NASA’s Jet Propulsion Laboratory in Southern California, a leader in robotic exploration of the solar system, manages the mission for the agency’s Science Mission Directorate in Washington.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Nineteen Samples Collected',
            body: `
            Psyche launched at 10:19 a.m. EDT Friday, October 13, 2023 aboard a SpaceX Falcon Heavy rocket from Launch Pad 39A at NASA’s Kennedy Space Center in Florida.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Twenty Samples Collected',
            body: `
            From launch to arrival at the first science orbit around the asteroid, the spacecraft will travel approximately 1.5 billion miles.
            `,
            image: "./images/psycherock.jpg"
        },
        {
            title: 'Twenty Samples Collected',
            body: `
            From launch to arrival at the first science orbit around the asteroid, the spacecraft will travel approximately 1.5 billion miles!
            `,
            image: "./images/psycherock.jpg"
        }
    ];

    const popupIndexRef = useRef(0);

    /** Counts AR movement ticks so we can emit a throttled position log for diagnostics. */
    const arMoveTickRef = useRef(0);

    /** Advances rover one step: projects input onto tangent plane, raycasts to surface, updates position and camera. */
    const moveRover = useCallback((inputX: number, inputY: number) => {
        if (gameState !== 'WEB_GAME' && gameState !== 'AR_MODE') return;
        if (showEndScreen) return;
        if (showIntroPopup) return;
        if (modeCfgRef.current.energyEnabled && energyRef.current <= 0) return;

        const THREE = (window as any).THREE;
        const roverId = gameState === 'AR_MODE' ? 'ar-rover' : 'rover';
        const rover = document.getElementById(roverId) as any;
        if (!THREE || !rover) return;

        /*
         * AR: the <a-entity id="ar-rover"> is remounted whenever the active marker anchor changes,
         * which resets its DOM position attribute to the JSX default ("0 0 0"). Reading the DOM
         * then would feed (0,0,0) into move_rover_on_asteroid every tick — which is inside the
         * asteroid volume — and the rover would "move freely" around origin instead of wrapping
         * the surface. Use the persisted roverPosRef as the source of truth instead.
         */
        const domPos = rover.getAttribute('position');
        const currentPos = gameState === 'AR_MODE' && roverPosRef.current
            ? roverPosRef.current
            : domPos;
        lastDirectionRef.current = [inputX, inputY];

        /* Convert screen-space input to world-space direction via camera frame. */
        const { right, up } = getCameraFrame(currentPos.x, currentPos.y, currentPos.z);
        const webStepScale = 0.5;
        let moveDir = gameState === 'AR_MODE'
            ? up.clone().multiplyScalar(inputY).addScaledVector(right, inputX).multiplyScalar(AR_ROVER_SPEED_SCALE)
            : up.clone().multiplyScalar(inputY * webStepScale).addScaledVector(right, inputX * webStepScale);
        let obstacleDrainMultiplier = 1.0;

        if(difficulty == 'normal' || difficulty == 'hard') {
            const cx = currentPos.x, cy = currentPos.y, cz = currentPos.z;
            const obs = obstaclesRef.current;
            const isCollidingWithObstacle = obs.some(o => {
                const dx = o.x - cx;
                const dy = o.y - cy;
                const dz = o.z - cz;
                return dx * dx + dy * dy + dz * dz < o.radius * o.radius;
            });

            const speedMultiplier = isCollidingWithObstacle ? 0.5 : 1.0;
            obstacleDrainMultiplier = isCollidingWithObstacle ? 6 : 1.0;

            if (isCollidingWithObstacle && !wasInObstacleRef.current) {
                setScore(s => Math.max(0, s - modeCfgRef.current.obstaclePenalty));
            }
            wasInObstacleRef.current = isCollidingWithObstacle;

            moveDir = moveDir.clone().multiplyScalar(speedMultiplier);
        }
        

        try {
            const result = move_rover_on_asteroid(
                moveDir.x, moveDir.y, moveDir.z,
                currentPos.x, currentPos.y, currentPos.z
            );
            // In AR, lift the rover slightly off the surface so it visually sits on top of the asteroid mesh.
            const [px, py, pz] = gameState === 'AR_MODE'
                ? pushOutFromCenter(result.position[0], result.position[1], result.position[2], arSurfaceOffset)
                : [result.position[0], result.position[1], result.position[2]];

            rover.setAttribute('position', {
                x: px,
                y: py,
                z: pz
            });
            // Remember the last surface position so we can restore it if the AR anchor switches markers.
            if (gameState === 'AR_MODE') {
                roverPosRef.current = { x: px, y: py, z: pz };
                // Throttle so the console isn't flooded — one log every ~60 ticks (~1/sec at 60Hz).
                arMoveTickRef.current++;
                if (arMoveTickRef.current % 60 === 0) {
                    console.log(`[AR] rover tick=${arMoveTickRef.current} position=(${px.toFixed(3)}, ${py.toFixed(3)}, ${pz.toFixed(3)}) magnitude=${Math.hypot(px, py, pz).toFixed(3)}`);
                }
            }

            updateRoverRotation(rover, px, py, pz, moveDir.x, moveDir.y, moveDir.z);
            // The follow camera only exists in the web scene; AR uses the real-world camera.
            if (gameState !== 'AR_MODE') {
                updateCamera(px, py, pz);
            }

            /* Update sample indicator arrow. */
            const arrowEl = document.getElementById('sample-arrow') as any;
            if (arrowEl) {
                const currentSamples = samplesRef.current;
                if (currentSamples.length === 0) {
                    arrowEl.setAttribute('visible', 'false');
                } else {
                    const rx2 = px, ry2 = py, rz2 = pz;
                    let nearest = currentSamples[0];
                    let nearestDist2 = Infinity;
                    for (const s of currentSamples) {
                        const dx = s.x - rx2, dy = s.y - ry2, dz = s.z - rz2;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        if (d2 < nearestDist2) { nearestDist2 = d2; nearest = s; }
                    }

                    const roverVec = new THREE.Vector3(rx2, ry2, rz2);
                    const normal = roverVec.clone().normalize();

                    // Tangent-plane direction toward nearest sample
                    const toSample = new THREE.Vector3(nearest.x - rx2, nearest.y - ry2, nearest.z - rz2).normalize();
                    const projected = toSample.clone().addScaledVector(normal, -toSample.dot(normal)).normalize();

                    if (projected.lengthSq() > 0.001) {
                        // Orbit: place arrow at fixed radius around rover in the sample's direction.
                        // In AR the orbit/normal offsets scale with the marker cube so the arrow fits the smaller world.
                        const orbitRadius = gameState === 'AR_MODE' ? arArrowOrbitRadius : 0.20;
                        const normalOffset = gameState === 'AR_MODE' ? arArrowNormalOffset : 0.04;
                        const arrowPos = roverVec.clone()
                            .addScaledVector(projected, orbitRadius)
                            .addScaledVector(normal, normalOffset);
                        arrowEl.setAttribute('position', `${arrowPos.x} ${arrowPos.y} ${arrowPos.z}`);

                        // Align arrow apex (+Y) with the projected direction (pointing away from rover)
                        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), projected);
                        const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
                        arrowEl.setAttribute('rotation', {
                            x: e.x * 180 / Math.PI,
                            y: e.y * 180 / Math.PI,
                            z: e.z * 180 / Math.PI,
                        });
                    }

                    arrowEl.setAttribute('visible', 'true');
                }
            }

            /* Drain energy on successful movement tick. */
            if (modeCfgRef.current.energyEnabled) {
                const drained = Math.max(0, energyRef.current - modeCfgRef.current.energyDrainPerSec * obstacleDrainMultiplier * (MOVE_INTERVAL / 1000));
                energyRef.current = drained;
                setEnergy(drained);
            }

            /* Check sample collection within radius. AR uses a marker-scaled radius. */
            const COLLECTION_RADIUS = gameState === 'AR_MODE' ? arCollectionRadius : 0.25;
            const rx = px, ry = py, rz = pz;
            const sps = samplesRef.current;
            const collectedSamples = sps.filter(s => {
                const dx = s.x - rx, dy = s.y - ry, dz = s.z - rz;
                return dx * dx + dy * dy + dz * dz < COLLECTION_RADIUS * COLLECTION_RADIUS;
            });
            if (collectedSamples.length > 0) {
                setSamples(prev => prev.filter(s => !collectedSamples.find(c => c.id === s.id)));
                setSamplesCollected(c => c + collectedSamples.length);
                setScore(s => s + collectedSamples.length * modeCfgRef.current.samplePoints);
                const idx = Math.min(popupIndexRef.current, popups.length - 1);
                const popup = popups[idx];
                if (popup) setWaypointPopup(popup);
                popupIndexRef.current += collectedSamples.length;
            }

        } catch (e) {
            console.error("Movement error:", e);
        }
    }, [gameState, difficulty, showEndScreen, showIntroPopup, arSurfaceOffset, arArrowOrbitRadius, arArrowNormalOffset, arCollectionRadius]);

    /**
     * Global keyboard handlers
     */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' || e.key === 'Enter') {
                if (showDifficulty) setShowDifficulty(false);
                if (showCredits) setShowCredits(false);
                if (showIntroPopup && introPopupCanClose) closeIntroPopup();
            }
        };

        window.addEventListener('keydown', onKey);

        return () => window.removeEventListener('keydown', onKey);
    }, [showDifficulty, showCredits, showIntroPopup, introPopupCanClose]);

    useEffect(() => {
        if (showDifficulty) {
            // focus first difficulty button when opening
            setTimeout(() => diffBtnRefs[0].current?.focus(), 50);
        } else {
            // return focus to Launch Mission button when closing
            setTimeout(() => playBtnRef.current?.focus(), 50);
        }
    }, [showDifficulty]);

    const creditsOpenedOnce = useRef(false);
    useEffect(() => {
        if (showCredits) {
            creditsOpenedOnce.current = true;
        } else if (creditsOpenedOnce.current) {
            // return focus to Credits button when closing (not on initial mount)
            setTimeout(() => creditsBtnRef.current?.focus(), 50);
        }
    }, [showCredits]);

    /**
     * Trap Tab focus inside the start screen when on MENU and modal is closed.
     * This prevents Tab from moving focus out of the app's start UI.
     */
    useEffect(() => {
        if (gameState !== 'MENU' || showDifficulty || showCredits) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            const order: HTMLElement[] = [];
            if (playBtnRef.current && !playBtnRef.current.hasAttribute('disabled')) order.push(playBtnRef.current);
            if (arBtnRef.current) order.push(arBtnRef.current);
            if (creditsBtnRef.current) order.push(creditsBtnRef.current);
            if (order.length === 0) return;

            const active = document.activeElement as HTMLElement;
            const idx = order.indexOf(active);
            const dir = e.shiftKey ? -1 : 1;
            let next: number;
            if (idx === -1) {
                next = dir === 1 ? 0 : order.length - 1;
            } else {
                next = (idx + dir + order.length) % order.length;
            }
            order[next].focus();
        };

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [gameState, showDifficulty, showCredits]);

    /** Aligns rover to surface normal with forward direction projected onto tangent plane. */
    const updateRoverRotation = (rover: any, x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number) => {
        const THREE = (window as any).THREE;
        if (!THREE || !rover.object3D) return;

        const surfaceNormal = new THREE.Vector3(x, y, z).normalize();

        /* Project movement direction onto tangent plane. */
        const forward = new THREE.Vector3(dirX, dirY, dirZ);
        forward.addScaledVector(surfaceNormal, -forward.dot(surfaceNormal));
        if (forward.length() < 0.001) return;
        forward.normalize();

        const right = new THREE.Vector3().crossVectors(forward, surfaceNormal).normalize();

        const matrix = new THREE.Matrix4();
        matrix.makeBasis(right, surfaceNormal, forward.clone().multiplyScalar(-1));

        const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
        rover.object3D.quaternion.copy(quaternion);
    };

    const CAMERA_HEIGHT = 2.0;
    const CAMERA_BEHIND = 1.2;

    /** Positions follow camera behind and above rover; look target offset toward asteroid center. */
    const updateCamera = (roverX: number, roverY: number, roverZ: number) => {
        const THREE = (window as any).THREE;
        const cam = document.getElementById('follow-camera') as any;
        if (!THREE || !cam?.object3D) return;

        const { up, normal } = getCameraFrame(roverX, roverY, roverZ);

        const roverPos = new THREE.Vector3(roverX, roverY, roverZ);
        const camPos = roverPos.clone()
            .addScaledVector(normal, CAMERA_HEIGHT)
            .addScaledVector(up, -CAMERA_BEHIND);

        const lookTarget = roverPos.clone().addScaledVector(roverPos.clone().negate(), 0.35);
        const forward = lookTarget.clone().sub(camPos).normalize();
        const camRight = new THREE.Vector3().crossVectors(forward, normal).normalize();
        const camUp = new THREE.Vector3().crossVectors(camRight, forward).normalize();

        cam.object3D.position.set(camPos.x, camPos.y, camPos.z);
        const m = new THREE.Matrix4().makeBasis(camRight, camUp, forward.clone().negate());
        cam.object3D.quaternion.setFromRotationMatrix(m);
    };

    /** Movement loop: merges keyboard and D-pad input, throttles to ~30 moves/sec. */
    const movementLoop = useCallback((timestamp: number) => {
        if (timestamp - lastMoveTime.current >= MOVE_INTERVAL) {
            lastMoveTime.current = timestamp;

            const k = keysHeld.current;
            const [padX, padY] = dpadInputRef.current;
            let inputX = padX;
            let inputY = padY;
            if (k.has('w') || k.has('arrowup')) inputY += 1;
            if (k.has('s') || k.has('arrowdown')) inputY -= 1;
            if (k.has('a') || k.has('arrowleft')) inputX -= 1;
            if (k.has('d') || k.has('arrowright')) inputX += 1;

            inputX = Math.max(-1, Math.min(1, inputX));
            inputY = Math.max(-1, Math.min(1, inputY));

            if (inputX !== 0 || inputY !== 0) moveRover(inputX, inputY);
        }

        const hasKeys = keysHeld.current.size > 0;
        const hasPad = dpadInputRef.current[0] !== 0 || dpadInputRef.current[1] !== 0;
        if (hasKeys || hasPad) {
            moveLoopId.current = requestAnimationFrame(movementLoop);
        } else {
            moveLoopId.current = null;
        }
    }, [moveRover]);

    /** Maps pointer position in circle to normalized input vector; center is dead zone. */
    const updateDpadFromPointer = useCallback((e: React.PointerEvent) => {
        const el = e.currentTarget;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        const radius = Math.min(rect.width, rect.height) / 2;
        const deadZone = radius * 0.2;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < deadZone) {
            dpadInputRef.current = [0, 0];
        } else {
            const mag = Math.min(1, (dist - deadZone) / (radius - deadZone));
            const inputX = (dx / dist) * mag;
            const inputY = -(dy / dist) * mag;
            dpadInputRef.current = [inputX, inputY];
        }
        if (moveLoopId.current === null) {
            moveLoopId.current = requestAnimationFrame(movementLoop);
        }
    }, [movementLoop]);

    const clearDpadInput = useCallback(() => {
        dpadInputRef.current = [0, 0];
    }, []);

    /** On game start: reset state and spawn samples/obstacles for both web and AR missions. */
    useEffect(() => {
        const THREE = (window as any).THREE;
        if (gameState === 'WEB_GAME' || gameState === 'AR_MODE') {
            setRoverReady(false);
            setScore(0);
            popupIndexRef.current = 0;
            setWaypointPopup(null);
            prevCamUp.current = null;
            // Force fresh surface spawn when entering a new mission.
            roverPosRef.current = null;
            if (meshLoaded && (gameState === 'WEB_GAME' || gameState === 'AR_MODE')) {
                // Obstacles — spawned first so sample placement can avoid them
                const obsList: { id: string; x: number; y: number; z: number; radius: number}[] = [];
                for (let i = 0; i < OBSTACLE_DIRECTIONS.length; i++) {
                    const [dx, dy, dz, radius] = OBSTACLE_DIRECTIONS[i % OBSTACLE_DIRECTIONS.length];
                    try {
                        const r = get_surface_point_in_direction(dx, dy, dz);
                        obsList.push({ id: `o-${i}`, x: r.position[0], y: r.position[1], z: r.position[2], radius });
                    } catch (_) {}
                }
                setObstacles(obsList);

                // Samples — randomly placed on the asteroid surface, skipping obstacle zones
                const sampleList: { id: string; x: number; y: number; z: number; model: SampleModel; rotation: string }[] = [];
                const MIN_SAMPLE_SPACING = 1.5;
                const MAX_ATTEMPTS = modeCfg.spawnSamples * 100;

                // Build a shuffled queue of model types (6 crystal / 7 ore / 7 rock for n=20)
                const n = modeCfg.spawnSamples;
                const base = Math.floor(n / 3);
                const extra = n % 3;
                const modelQueue: SampleModel[] = [
                    ...Array<SampleModel>(base).fill('crystal'),
                    ...Array<SampleModel>(base + (extra >= 1 ? 1 : 0)).fill('ore'),
                    ...Array<SampleModel>(base + (extra >= 2 ? 1 : 0)).fill('rock'),
                ];
                for (let i = modelQueue.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [modelQueue[i], modelQueue[j]] = [modelQueue[j], modelQueue[i]];
                }

                let attempts = 0;
                while (sampleList.length < modeCfg.spawnSamples && attempts < MAX_ATTEMPTS) {
                    attempts++;
                    const dir = randomUnitVector();
                    try {
                        const r = get_surface_point_in_direction(dir[0], dir[1], dir[2]);
                        const insideObstacle = obsList.some(o => {
                            const dx = r.position[0] - o.x;
                            const dy = r.position[1] - o.y;
                            const dz = r.position[2] - o.z;
                            return dx * dx + dy * dy + dz * dz < o.radius * o.radius;
                        });
                        const tooClose = sampleList.some(s => {
                            const dx = r.position[0] - s.x;
                            const dy = r.position[1] - s.y;
                            const dz = r.position[2] - s.z;
                            return dx * dx + dy * dy + dz * dz < MIN_SAMPLE_SPACING * MIN_SAMPLE_SPACING;
                        });
                        if (!insideObstacle && !tooClose) {
                            // Align sample local +Y with the surface normal (approximated by position-from-origin),
                            // then add a random yaw around that normal for visual variety.
                            const px = r.position[0], py = r.position[1], pz = r.position[2];
                            const normal = new THREE.Vector3(px, py, pz).normalize();
                            const alignQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
                            const yawQ = new THREE.Quaternion().setFromAxisAngle(normal, Math.random() * Math.PI * 2);
                            alignQ.premultiply(yawQ);
                            const e = new THREE.Euler().setFromQuaternion(alignQ, 'YXZ');
                            const R2D = 180 / Math.PI;
                            const rotation = `${e.x * R2D} ${e.y * R2D} ${e.z * R2D}`;
                            sampleList.push({ id: `s-${sampleList.length}`, x: px, y: py, z: pz, model: modelQueue[sampleList.length], rotation });
                        }
                    } catch (_) { }
                }
                setSamples(sampleList);
                const arrowElStart = document.getElementById('sample-arrow') as any;
                if (arrowElStart) arrowElStart.setAttribute('visible', 'true');

                energyRef.current = MAX_ENERGY;
                setEnergy(MAX_ENERGY);
                wasInObstacleRef.current = false;
                endTriggeredRef.current = false;
            } else {
                setSamples([]);
                setObstacles([]);
                const arrowElStop = document.getElementById('sample-arrow') as any;
                if (arrowElStop) arrowElStop.setAttribute('visible', 'false');
            }
        }
    }, [gameState, meshLoaded]);

    /** Trigger end screen when all samples collected or energy depleted (web or AR). */
    useEffect(() => {
        if ((gameState !== 'WEB_GAME' && gameState !== 'AR_MODE') || endTriggeredRef.current) return;
        if (samplesCollected >= modeCfg.spawnSamples) {
            endTriggeredRef.current = true;
            const bonus = modeCfg.energyBonusEnabled ? Math.round((energyRef.current / MAX_ENERGY) * 1000) : 0;
            setEnergyBonus(bonus);
            setScore(s => s + bonus);
            setEndReason('complete');
            setShowEndScreen(true);
        } else if (modeCfg.energyEnabled && energy <= 0) {
            endTriggeredRef.current = true;
            setEnergyBonus(0);
            setEndReason('energy');
            setShowEndScreen(true);
        }
    }, [samplesCollected, energy, gameState]);

    /** Keyboard listeners and rover init: snap to surface before revealing scene. */
    useEffect(() => {
        if ((gameState !== 'WEB_GAME' && gameState !== 'AR_MODE') || !meshLoaded) {
            return () => { };
        }
        let cancelled = false;
        let retryTimer: number | null = null;

        const scheduleRetry = () => {
            if (cancelled) return;
            retryTimer = window.setTimeout(initRover, 100);
        };

        const initRover = () => {
            if (cancelled) return;
            const roverId = gameState === 'AR_MODE' ? 'ar-rover' : 'rover';
            const rover = document.getElementById(roverId) as any;
            if (!rover) {
                scheduleRetry();
                return;
            }

            try {
                let px: number, py: number, pz: number;
                if (gameState === 'AR_MODE') {
                    if (roverPosRef.current) {
                        // Anchor switched (or re-init): keep the rover where it was on the asteroid surface.
                        ({ x: px, y: py, z: pz } = roverPosRef.current);
                    } else {
                        // Deterministic first-time AR spawn on asteroid surface relative to marker anchor.
                        const result = get_surface_point_in_direction(
                            AR_ROVER_START_DIRECTION[0],
                            AR_ROVER_START_DIRECTION[1],
                            AR_ROVER_START_DIRECTION[2]
                        );
                        [px, py, pz] = pushOutFromCenter(result.position[0], result.position[1], result.position[2], arSurfaceOffset);
                        roverPosRef.current = { x: px, y: py, z: pz };
                    }
                } else {
                    const pos = rover.getAttribute('position');
                    const result = move_rover_on_asteroid(0, 0, 0, pos.x, pos.y, pos.z);
                    [px, py, pz] = [result.position[0], result.position[1], result.position[2]];
                }

                rover.setAttribute('position', { x: px, y: py, z: pz });

                /*
                 * Orient the rover to the surface normal BEFORE the user starts moving. If we pass
                 * a zero dir (no input yet) updateRoverRotation bails, leaving the rover in its
                 * JSX default orientation — which looks like it's "floating off" the surface in AR
                 * (no follow-camera to hide it). Use the camera-frame "up" as a sensible default
                 * forward direction along the tangent plane.
                 */
                const { up } = getCameraFrame(px, py, pz);
                updateRoverRotation(rover, px, py, pz, up.x, up.y, up.z);
                if (gameState !== 'AR_MODE') {
                    updateCamera(px, py, pz);
                }

                if (gameState === 'AR_MODE') {
                    console.log(`[AR] rover init OK → position=(${px.toFixed(3)}, ${py.toFixed(3)}, ${pz.toFixed(3)}) | magnitude=${Math.hypot(px, py, pz).toFixed(3)}`);
                }
                setRoverReady(true);
            } catch (e) {
                console.error("Rover init failed:", e);
                scheduleRetry();
            }
        };

        const t = setTimeout(initRover, 50);

        const validKeys = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

        const onKeyDown = (e: KeyboardEvent) => {
            if (showIntroPopupRef.current) return;
            const key = e.key.toLowerCase();
            if (!validKeys.has(key)) return;
            e.preventDefault();
            keysHeld.current.add(key);
            if (moveLoopId.current === null) {
                moveLoopId.current = requestAnimationFrame(movementLoop);
            }
        };

        const onKeyUp = (e: KeyboardEvent) => {
            keysHeld.current.delete(e.key.toLowerCase());
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        return () => {
            cancelled = true;
            clearTimeout(t);
            if (retryTimer !== null) window.clearTimeout(retryTimer);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            if (moveLoopId.current !== null) {
                cancelAnimationFrame(moveLoopId.current);
                moveLoopId.current = null;
            }
            keysHeld.current.clear();
        };
    }, [gameState, meshLoaded, movementLoop, arSurfaceOffset]);

    /**
     * AR: when the active marker anchor changes, the <a-entity id="ar-rover"> is remounted in a new
     * subtree with its JSX position ("0 0 0"). Re-apply the stored surface position / orientation so
     * the rover stays glued to the asteroid instead of drifting back to the parent origin.
     */
    useEffect(() => {
        if (gameState !== 'AR_MODE') return;
        if (arAnchorId === null) return;
        let cancelled = false;
        let attempts = 0;
        const apply = () => {
            if (cancelled) return;
            const rover = document.getElementById('ar-rover') as any;
            if (!rover || !rover.object3D) {
                attempts++;
                if (attempts < 60) window.setTimeout(apply, 50);
                return;
            }
            try {
                let px: number, py: number, pz: number;
                if (roverPosRef.current) {
                    ({ x: px, y: py, z: pz } = roverPosRef.current);
                } else {
                    const result = get_surface_point_in_direction(
                        AR_ROVER_START_DIRECTION[0],
                        AR_ROVER_START_DIRECTION[1],
                        AR_ROVER_START_DIRECTION[2]
                    );
                    [px, py, pz] = pushOutFromCenter(result.position[0], result.position[1], result.position[2], arSurfaceOffset);
                    roverPosRef.current = { x: px, y: py, z: pz };
                }
                rover.setAttribute('position', { x: px, y: py, z: pz });
                const [ix, iy] = lastDirectionRef.current;
                const { right, up } = getCameraFrame(px, py, pz);
                const hasInput = Math.abs(ix) > 1e-6 || Math.abs(iy) > 1e-6;
                const dir = hasInput
                    ? up.clone().multiplyScalar(iy).addScaledVector(right, ix)
                    : up.clone();
                updateRoverRotation(rover, px, py, pz, dir.x, dir.y, dir.z);
                console.log(`[AR] rover re-snapped after anchor change → position=(${px.toFixed(3)}, ${py.toFixed(3)}, ${pz.toFixed(3)})`);
                setRoverReady(true);
            } catch (e) {
                console.error("AR rover re-snap failed:", e);
            }
        };
        apply();
        return () => { cancelled = true; };
    }, [gameState, arAnchorId, arSurfaceOffset]);

    /** AR calibration source: center offsets computed from solved marker reports/config. */
    useEffect(() => {
        if (gameState !== 'AR_MODE') return;
        let cancelled = false;
        (async () => {
            try {
                let byId: Record<number, number[]> = {};
                let centerFromSource: MarkerOffset | undefined;

                try {
                    // Primary: public/surface_pair_report.json — marker poseMatrix + center_1346_m (meters, Three.js Y-up).
                    const sr = await fetch(`${import.meta.env.BASE_URL}surface_pair_report.json?ts=${Date.now()}`);
                    if (sr.ok) {
                        const report = await sr.json();
                        const parsed = parsePosesFromReport(report);
                        if (parsed) {
                            byId = parsed.byId;
                            centerFromSource = parsed.center;
                        }
                    }
                } catch {
                    /* optional file */
                }

                try {
                    if (Object.keys(byId).length === 0) {
                        const rr = await fetch(`${import.meta.env.BASE_URL}table_rotation_report.json?ts=${Date.now()}`);
                        if (rr.ok) {
                            const report = await rr.json();
                            const parsed = parsePosesFromReport(report);
                            if (parsed) {
                                byId = parsed.byId;
                                centerFromSource = parsed.center;
                            }
                        }
                    }
                } catch {
                    /* optional file */
                }

                if (Object.keys(byId).length === 0) {
                    const res = await fetch(`${import.meta.env.BASE_URL}config.json`);
                    const json = await res.json();
                    byId = parsePosesFromConfig(json);
                }

                const tablePoses = TABLE_MARKER_IDS.map((id) => byId[id]).filter(Boolean) as number[][];
                if (tablePoses.length === 0) {
                    if (!cancelled) setCenterOffsetsById({});
                    return;
                }

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
                    next[id] = {
                        x: offM.x / MARKER_SIZE_METERS,
                        y: offM.y / MARKER_SIZE_METERS,
                        z: offM.z / MARKER_SIZE_METERS,
                    };
                }
                if (!cancelled) {
                    setCenterOffsetsById(next);
                    console.log('[AR] calibration loaded. center offsets (marker-local, marker units):', JSON.stringify(next));
                }
            } catch (e) {
                console.warn('[AR] calibration load failed:', e);
                if (!cancelled) setCenterOffsetsById({});
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [gameState]);

    /** AR marker visibility tracking via AR.js markerFound/markerLost events. */
    useEffect(() => {
        if (gameState !== 'AR_MODE') return;
        const els = ALL_MARKER_IDS.map((id) => document.querySelector(`a-marker[type="barcode"][value="${id}"]`));
        const onFound = (id: number) => () => {
            console.log(`[AR] markerFound id=${id}`);
            setArVisibleIds((prev) => new Set(prev).add(id));
        };
        const onLost = (id: number) => () => {
            console.log(`[AR] markerLost id=${id}`);
            setArVisibleIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        };
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
    }, [gameState]);

    /** Poll-based fallback for marker visibility + drives the scan prompt + grace period for tracking jitter. */
    useEffect(() => {
        if (gameState !== 'AR_MODE') return;
        const interval = window.setInterval(() => {
            const now = Date.now();
            const next = new Set<number>();
            for (const id of ALL_MARKER_IDS) {
                const el = document.querySelector(`a-marker[type="barcode"][value="${id}"]`) as any;
                const isVisible = Boolean(el?.object3D?.visible);
                if (isVisible) {
                    arLastSeenMsRef.current[id] = now;
                    next.add(id);
                    continue;
                }
                const lastSeen = arLastSeenMsRef.current[id] ?? 0;
                if (now - lastSeen <= markerLostGraceMs) next.add(id);
            }
            setArVisibleIds((prev) => (setsEqual(prev, next) ? prev : next));
            setScanPrompt(next.size === 0);
        }, 120);
        return () => window.clearInterval(interval);
    }, [gameState]);

    /** Anchor selection: prefer marker 4 if visible, otherwise debounce-hold on another. */
    useEffect(() => {
        if (gameState !== 'AR_MODE') return;
        if (arAnchorHoldTimeoutRef.current !== null) {
            window.clearTimeout(arAnchorHoldTimeoutRef.current);
            arAnchorHoldTimeoutRef.current = null;
        }
        if (arVisibleIds.has(4)) {
            if (arAnchorId !== 4) console.log('[AR] anchor → 4 (preferred)');
            setArAnchorId(4);
            return;
        }
        if (arAnchorId !== null && arVisibleIds.has(arAnchorId)) return;
        const next = ALL_MARKER_IDS.find((id) => arVisibleIds.has(id)) ?? null;
        arAnchorHoldTimeoutRef.current = window.setTimeout(() => {
            console.log(`[AR] anchor → ${next === null ? 'none' : next} (after ${anchorSwitchDebounceMs}ms debounce)`);
            setArAnchorId(next);
            arAnchorHoldTimeoutRef.current = null;
        }, anchorSwitchDebounceMs);
    }, [gameState, arVisibleIds, arAnchorId]);

    const activeAnchorId = arAnchorId;

    return (
        <div className="ar-container">
            {gameState === 'MENU' && (
                <div id="start-screen">
                    {/* Modern Star Field */}
                    <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        overflow: 'hidden',
                        pointerEvents: 'none'
                    }}>
                        {/* Glowing orbs */}
                        {[
                            { top: '12%', left: '18%', size: 6, blur: 15, color: 'rgba(0, 212, 255, 0.8)', delay: 0 },
                            { top: '28%', left: '82%', size: 8, blur: 20, color: 'rgba(123, 44, 191, 0.7)', delay: 0.5 },
                            { top: '58%', left: '12%', size: 5, blur: 12, color: 'rgba(255, 255, 255, 0.9)', delay: 1 },
                            { top: '78%', left: '72%', size: 7, blur: 18, color: 'rgba(0, 212, 255, 0.6)', delay: 1.5 },
                            { top: '22%', left: '48%', size: 4, blur: 10, color: 'rgba(255, 255, 255, 0.8)', delay: 0.8 },
                            { top: '88%', left: '38%', size: 6, blur: 16, color: 'rgba(123, 44, 191, 0.6)', delay: 1.2 },
                            { top: '8%', left: '88%', size: 5, blur: 14, color: 'rgba(255, 255, 255, 0.7)', delay: 0.3 },
                            { top: '48%', left: '6%', size: 4, blur: 11, color: 'rgba(0, 212, 255, 0.7)', delay: 1.8 },
                            { top: '35%', left: '62%', size: 3, blur: 8, color: 'rgba(255, 255, 255, 0.6)', delay: 0.4 },
                            { top: '65%', left: '88%', size: 4, blur: 10, color: 'rgba(123, 44, 191, 0.5)', delay: 1.1 },
                            { top: '82%', left: '22%', size: 3, blur: 9, color: 'rgba(255, 255, 255, 0.7)', delay: 0.7 },
                            { top: '15%', left: '38%', size: 5, blur: 13, color: 'rgba(0, 212, 255, 0.6)', delay: 1.4 },
                            { top: '42%', left: '75%', size: 4, blur: 11, color: 'rgba(255, 255, 255, 0.8)', delay: 0.9 },
                            { top: '72%', left: '55%', size: 6, blur: 15, color: 'rgba(123, 44, 191, 0.7)', delay: 1.6 },
                            { top: '5%', left: '65%', size: 3, blur: 8, color: 'rgba(255, 255, 255, 0.6)', delay: 0.2 },
                            { top: '92%', left: '58%', size: 4, blur: 10, color: 'rgba(0, 212, 255, 0.5)', delay: 1.3 },
                        ].map((star, i) => (
                            <div
                                key={`star-${i}`}
                                style={{
                                    position: 'absolute',
                                    top: star.top,
                                    left: star.left,
                                    width: `${star.size}px`,
                                    height: `${star.size}px`,
                                    borderRadius: '50%',
                                    background: star.color,
                                    boxShadow: `0 0 ${star.blur}px ${star.color}, 0 0 ${star.blur * 2}px ${star.color}`,
                                    animation: `twinkle ${2.5 + Math.random() * 2}s ease-in-out infinite`,
                                    animationDelay: `${star.delay}s`,
                                }}
                            />
                        ))}
                    </div>

                    <div className="mission-badge">
                        <div className="badge-label">NASA Capstone Project8</div>
                    </div>
                    <h1>Psyche</h1>
                    <p className="subtitle">Explore • Navigate • Discover</p>
                    <div className="button-container">
                        <button id="play-button" ref={playBtnRef} onClick={() => { setLaunchInAr(false); setShowDifficulty(true); }} disabled={!meshLoaded}>
                            {meshLoaded ? 'Launch Mission' : 'Loading...'}
                        </button>
                        <button id="start-button" ref={arBtnRef} onClick={() => { setLaunchInAr(true); setShowDifficulty(true); }} disabled={!meshLoaded}>
                            {meshLoaded ? 'AR Experience' : 'Loading...'}
                        </button>
                        <button id="credits-button" ref={creditsBtnRef} onClick={() => setShowCredits(true)}>Credits</button>
                    </div>
                    <div className={`difficulty-overlay ${showDifficulty ? 'open' : 'closed'}`} onClick={() => setShowDifficulty(false)}>
                        <div className="difficulty-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-hidden={!showDifficulty}>
                            <h2 className="difficulty-title">{launchInAr ? 'AR Experience — Select Difficulty' : 'Select Difficulty'}</h2>
                            <p className="difficulty-sub">
                                {launchInAr
                                    ? 'Point your camera at the printed markers to anchor the asteroid on your table.'
                                    : 'Choose how challenging the mission will be.'}
                            </p>

                            <div className="difficulty-buttons" onKeyDown={(e) => {
                                // Trap Tab navigation between the three difficulty buttons
                                if (e.key === 'Tab') {
                                    e.preventDefault();
                                    const refs = diffBtnRefs;
                                    const focusedIndex = refs.findIndex(r => r.current === document.activeElement);
                                    const dir = e.shiftKey ? -1 : 1;
                                    let next = focusedIndex + dir;
                                    if (next < 0) next = refs.length - 1;
                                    if (next >= refs.length) next = 0;
                                    refs[next].current?.focus();
                                }
                            }}>
                                <button ref={diffBtnRefs[0]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart(launchInAr ? 'ar' : 'web_game', 'easy'); }}>Story</button>
                                <button ref={diffBtnRefs[1]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart(launchInAr ? 'ar' : 'web_game', 'normal'); }}>Standard</button>
                                <button ref={diffBtnRefs[2]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart(launchInAr ? 'ar' : 'web_game', 'hard'); }}>Challenge</button>
                            </div>
                        </div>
                    </div>
                    <div className={`credits-overlay ${showCredits ? 'open' : 'closed'}`} onClick={() => setShowCredits(false)}>
                        <div className="credits-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-hidden={!showCredits}>
                            <h2 className="credits-title">Credits</h2>

                            <section className="credits-section">
                                <h3 className="credits-section-heading">Creators</h3>
                                <ul className="credits-list">
                                    <li>Matthew Andrews — Systems Programmer</li>
                                    <li>Brian Devaney — Technical Director</li>
                                    <li>Methsiri Faris — AR Engineer</li>
                                    <li>Evelyn Giordano — Technical Artist</li>
                                    <li>Nathaniel Wilson — Gameplay Programmer</li>
                                </ul>
                            </section>

                            <section className="credits-section">
                                <h3 className="credits-section-heading">Sponsors</h3>
                                <ul className="credits-list">
                                    <li>NASA Psyche Mission</li>
                                    <li>Cassie Bowman — Arizona State University </li>
                                    <li>Alejandro Gomez — University of Arkansas</li>
                                </ul>
                            </section>

                            <section className="credits-section">
                                <h3 className="credits-section-heading">Disclaimer</h3>
                                <p className="credits-disclaimer">
                                    This work was created in partial fulfillment of University of Arkansas Capstone Course “CSCE 49603 - Capstone II″. The work is a result of the Psyche Student Collaborations component of NASA’s Psyche Mission (https://psyche.ssl.berkeley.edu)
                                    “Psyche: A Journey to a Metal World” [Contract number NNM16AA09C] is part of the NASA Discovery Program mission to solar system targets. Trade names and trademarks of ASU and NASA are used in this work for identification only.
                                    Their usage does not constitute an official endorsement, either expressed or implied, by Arizona State University or National Aeronautics and Space Administration. The content is solely the responsibility of the authors and does not necessarily represent the official views of ASU or NASA.
                                </p>
                            </section>

                            <button className="credits-close-btn" onClick={() => setShowCredits(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {gameState === 'AR_MODE' && (
                <>
                    {/* AR Scene with Camera Access — marker-anchored, calibrated asteroid world. */}
                    <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}>
                        <a-scene
                            embedded
                            style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}
                            arjs="sourceType: webcam; detectionMode: mono_and_matrix; matrixCodeType: 3x3_HAMMING63; patternRatio: 0.52;"
                            vr-mode-ui="enabled: false"
                            renderer="logarithmicDepthBuffer: true;"
                        >
                            <a-camera position="0 0 0" look-controls="enabled: false"></a-camera>

                            {/* Lighting so the glb samples/asteroid are readable in AR */}
                            <a-light type="ambient" color="#FFFFFF" intensity="0.9"></a-light>
                            <a-light type="directional" color="#FFFFFF" intensity="0.8" position="3 5 4"></a-light>

                            {[...TABLE_MARKER_IDS, ...SURFACE_MARKER_IDS].map((id) => {
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
                                        {/*
                                          * Calibration reference cube. Direct child of <a-marker>, so it lives in the
                                          * marker's raw local frame — NO shared transform with the asteroid / rover / samples.
                                          * Purely a visual probe: if you see a red cube on the physical marker, AR.js is
                                          * tracking and your calibration offsets are sensible. Toggle via showCalibrationCube.
                                          */}
                                        {showCalibrationCube && (
                                            <a-box
                                                position={`${markerOverlayShiftX} ${markerPlaneOffset + markerOverlayDepth / 2} ${markerOverlayShiftZ}`}
                                                rotation="-90 0 0"
                                                width={markerOverlayWidth}
                                                height={markerOverlayDepth}
                                                depth={markerOverlayHeight}
                                                material="color: #ff0000; shader: flat; side: double; transparent: true; opacity: 0.55"
                                            />
                                        )}

                                        {activeAnchorId === id && (
                                            <a-entity position={`${c.x} ${c.y} ${c.z}`}>
                                                <a-entity
                                                    position={`0 ${modelLift} ${modelBack}`}
                                                    rotation={`${modelPitchOffsetDeg} ${modelYawOffsetDeg} ${modelRollOffsetDeg}`}
                                                    scale={`${modelScaleX} ${modelScaleY} ${modelScaleZ}`}
                                                >
                                                    {showArAsteroid && (
                                                        <a-entity position={arAsteroidGltfPosition} scale={arAsteroidGltfScale}>
                                                            <a-gltf-model src={arAsteroidModelSrc} />
                                                        </a-entity>
                                                    )}

                                                    {/* Samples — GLB models matching the web game, scaled down for the marker-anchored world. */}
                                                    {samples.map((s) => (
                                                        <a-entity key={`ar-${s.id}`} position={`${s.x} ${s.y} ${s.z}`} rotation={s.rotation}>
                                                            <a-gltf-model src={`./models/${s.model}.glb`} scale={arSampleScaleStr} />
                                                        </a-entity>
                                                    ))}

                                                    {/* Obstacles (visual only — physics is enforced in moveRover) */}
                                                    {obstacles.map((o) => (
                                                        <a-entity key={`ar-${o.id}`} position={`${o.x} ${o.y} ${o.z}`}>
                                                            <a-sphere radius={o.radius / arObstacleParentScaleMean} color="#ff4d4d" material="transparent: true; opacity: 0.6" />
                                                        </a-entity>
                                                    ))}

                                                    {/* Nearest-sample indicator arrow (tangent-plane orbit). */}
                                                    <a-entity id="sample-arrow" visible="false">
                                                        <a-entity animation="property: scale; from: 1 1 1; to: 1.35 1.35 1.35; loop: true; dir: alternate; dur: 500; easing: easeInOutSine">
                                                            <a-cone
                                                                height={arArrowConeHeight}
                                                                radius-bottom={arArrowConeRadiusBottom}
                                                                radius-top="0"
                                                                color="#FFD700"
                                                                position={`0 ${arArrowConeY} 0`}
                                                                material="emissive: #FFD700; emissiveIntensity: 0.55; transparent: true; opacity: 0.95"
                                                            />
                                                            <a-cylinder
                                                                radius={arArrowCylRadius}
                                                                height={arArrowCylHeight}
                                                                color="#FFD700"
                                                                position={`0 ${arArrowCylY} 0`}
                                                                material="emissive: #FFD700; emissiveIntensity: 0.35; transparent: true; opacity: 0.8"
                                                            />
                                                        </a-entity>
                                                    </a-entity>

                                                    {/* Rover — identical primitive-built mesh used in the web game; compensates for non-uniform parent scale. */}
                                                    <a-entity
                                                        id="ar-rover"
                                                        position="0 0 0"
                                                        rotation="0 0 0"
                                                        scale={arRoverScaleStr}
                                                        visible={roverReady ? 'true' : 'false'}
                                                    >
                                                        {/* Debug sphere — bright unlit green, always-on-top, co-located with rover pivot. */}
                                                        {showArRoverDebugSphere && (
                                                            <a-sphere
                                                                radius="0.35"
                                                                color="#00ff6a"
                                                                material="shader: flat; transparent: true; opacity: 0.55; depthTest: false"
                                                                position="0 0 0"
                                                            />
                                                        )}
                                                        <a-box width="0.1" height="0.16" depth="0.52" color="#2A2A2A" position="-0.25 -0.04 0"></a-box>
                                                        <a-box width="0.1" height="0.16" depth="0.52" color="#2A2A2A" position="0.25 -0.04 0"></a-box>
                                                        <a-cylinder radius="0.08" height="0.1" rotation="0 0 90" color="#3A3A3A" position="-0.25 -0.04 -0.2"></a-cylinder>
                                                        <a-cylinder radius="0.08" height="0.1" rotation="0 0 90" color="#3A3A3A" position="-0.25 -0.04 0.2"></a-cylinder>
                                                        <a-cylinder radius="0.08" height="0.1" rotation="0 0 90" color="#3A3A3A" position="0.25 -0.04 -0.2"></a-cylinder>
                                                        <a-cylinder radius="0.08" height="0.1" rotation="0 0 90" color="#3A3A3A" position="0.25 -0.04 0.2"></a-cylinder>
                                                        <a-box width="0.4" height="0.32" depth="0.36" color="#B8963E" position="0 0.14 0"></a-box>
                                                        <a-box width="0.38" height="0.28" depth="0.01" color="#8B7230" position="0 0.15 -0.18"></a-box>
                                                        <a-box width="0.38" height="0.28" depth="0.01" color="#8B7230" position="0 0.15 0.18"></a-box>
                                                        <a-box width="0.42" height="0.02" depth="0.38" color="#9E8438" position="0 0.31 0"></a-box>
                                                        <a-cylinder radius="0.025" height="0.18" color="#707070" position="0 0.41 -0.04"></a-cylinder>
                                                        <a-cylinder radius="0.025" height="0.18" color="#707070" position="0 0.41 -0.04" rotation="0 0 6"></a-cylinder>
                                                        <a-box width="0.26" height="0.07" depth="0.07" color="#606060" position="0 0.52 -0.06"></a-box>
                                                        <a-cylinder radius="0.055" height="0.14" rotation="90 0 0" color="#505050" position="-0.08 0.52 -0.14"></a-cylinder>
                                                        <a-cylinder radius="0.055" height="0.14" rotation="90 0 0" color="#505050" position="0.08 0.52 -0.14"></a-cylinder>
                                                        <a-cylinder radius="0.058" height="0.02" rotation="90 0 0" color="#404040" position="-0.08 0.52 -0.21"></a-cylinder>
                                                        <a-cylinder radius="0.058" height="0.02" rotation="90 0 0" color="#404040" position="0.08 0.52 -0.21"></a-cylinder>
                                                        <a-sphere radius="0.048" color="#6DB8D4" position="-0.08 0.52 -0.22"></a-sphere>
                                                        <a-sphere radius="0.048" color="#6DB8D4" position="0.08 0.52 -0.22"></a-sphere>
                                                        <a-sphere radius="0.025" color="#1A1A1A" position="-0.08 0.52 -0.25"></a-sphere>
                                                        <a-sphere radius="0.025" color="#1A1A1A" position="0.08 0.52 -0.25"></a-sphere>
                                                        <a-box width="0.035" height="0.035" depth="0.18" color="#707070" rotation="15 0 0" position="-0.24 0.14 -0.14"></a-box>
                                                        <a-box width="0.035" height="0.035" depth="0.18" color="#707070" rotation="15 0 0" position="0.24 0.14 -0.14"></a-box>
                                                        <a-box width="0.06" height="0.02" depth="0.06" color="#606060" rotation="15 0 0" position="-0.24 0.14 -0.25"></a-box>
                                                        <a-box width="0.06" height="0.02" depth="0.06" color="#606060" rotation="15 0 0" position="0.24 0.14 -0.25"></a-box>
                                                        <a-box width="0.08" height="0.02" depth="0.2" color="#555555" position="0 0.33 0"></a-box>
                                                    </a-entity>
                                                </a-entity>
                                            </a-entity>
                                        )}
                                    </a-marker>
                                );
                            })}
                        </a-scene>
                    </div>

                    <div id="ui-overlay" style={{ display: 'block' }}>
                        {scanPrompt && (
                            <div id="scan-prompt">
                                Point camera at AR marker
                            </div>
                        )}

                        <div id="score-display">
                            SCORE <span id="score">{score}</span>
                        </div>

                        <div className="mode-ui">
                            {modeCfg.energyEnabled && <div className="energy-display">ENERGY <div className="energy-bar"><div style={{ width: `${(energy / MAX_ENERGY) * 100}%` }} /></div></div>}
                            <div className="samples-display">SAMPLES <span style={{ color: '#7bffb2', fontWeight: 800 }}>{samplesCollected}</span> / {modeCfg.spawnSamples}</div>
                        </div>

                        {/*
                          * AR CALIBRATION PANEL
                          * Live-drag the sliders until the virtual asteroid matches the physical one.
                          * Values are saved to localStorage under `nasa-psyche-ar-calibration-v1` so
                          * they survive reloads. Use "Copy JSON" to grab the final values and bake
                          * them into AR_CALIBRATION_DEFAULTS in code.
                          */}
                        <button
                            type="button"
                            onClick={() => setShowArCalibrationPanel((s) => !s)}
                            style={{
                                position: 'fixed',
                                top: 12,
                                right: 12,
                                zIndex: 1001,
                                padding: '8px 12px',
                                borderRadius: 8,
                                border: '1px solid rgba(255,255,255,0.25)',
                                background: 'rgba(20, 24, 36, 0.75)',
                                color: '#E6F2FF',
                                fontSize: 12,
                                fontWeight: 700,
                                letterSpacing: 0.4,
                                cursor: 'pointer',
                                backdropFilter: 'blur(6px)',
                                pointerEvents: 'auto',
                            }}
                        >
                            {showArCalibrationPanel ? 'Hide Calibration' : 'Calibrate'}
                        </button>
                        {showArCalibrationPanel && (
                            <div
                                style={{
                                    position: 'fixed',
                                    top: 52,
                                    right: 12,
                                    zIndex: 1001,
                                    width: 300,
                                    maxHeight: 'calc(100vh - 80px)',
                                    overflowY: 'auto',
                                    padding: 14,
                                    borderRadius: 12,
                                    border: '1px solid rgba(255,255,255,0.18)',
                                    background: 'rgba(10, 14, 24, 0.85)',
                                    color: '#E6F2FF',
                                    fontSize: 12,
                                    fontFamily: 'system-ui, sans-serif',
                                    backdropFilter: 'blur(8px)',
                                    boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
                                    pointerEvents: 'auto',
                                }}
                                onClick={(e) => e.stopPropagation()}
                            >
                                <div style={{ fontWeight: 800, letterSpacing: 0.6, marginBottom: 8 }}>AR ASTEROID ALIGNMENT</div>
                                <div style={{ fontSize: 10, opacity: 0.75, marginBottom: 10, lineHeight: 1.45 }}>
                                    Physical print {Math.round(PHYSICAL_ASTEROID_BBOX_M.x * 1000)}×{Math.round(PHYSICAL_ASTEROID_BBOX_M.y * 1000)}×{Math.round(PHYSICAL_ASTEROID_BBOX_M.z * 1000)} mm;
                                    centers from <code style={{ fontSize: 9 }}>surface_pair_report.json</code>.
                                    Matched uniform scale ≈{' '}
                                    <span style={{ color: '#7bffb2' }}>{AR_PHYSICAL_MATCH_UNIFORM_SCALE.toFixed(3)}</span>
                                    {' '}(marker units; 1 unit = {MARKER_SIZE_METERS * 1000} mm).
                                </div>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const s = AR_PHYSICAL_MATCH_UNIFORM_SCALE;
                                        setArCalibration((prev) => ({
                                            ...prev,
                                            modelScaleX: s,
                                            modelScaleY: s,
                                            modelScaleZ: s,
                                            modelLift: (-30.15 * s) / LEGACY_AR_MODEL_SCALE_REF,
                                            modelBack: 0,
                                        }));
                                    }}
                                    style={{
                                        width: '100%',
                                        marginBottom: 12,
                                        padding: '8px 10px',
                                        borderRadius: 8,
                                        border: '1px solid rgba(123,255,178,0.35)',
                                        background: 'rgba(24, 52, 40, 0.9)',
                                        color: '#7bffb2',
                                        fontSize: 11,
                                        fontWeight: 800,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Match physical print (610×524×432 mm)
                                </button>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, cursor: 'pointer', fontSize: 11 }}>
                                    <input
                                        type="checkbox"
                                        checked={compensateScaleWithLift}
                                        onChange={(e) => updateArCalibration({ compensateScaleWithLift: e.target.checked })}
                                    />
                                    <span>
                                        Auto-scale with Lift (keep ~same on-screen size when you push the rock deeper on Y — e.g. scale 12 at Y −60 vs Y −90)
                                    </span>
                                </label>
                                {compensateScaleWithLift && (
                                    <div style={{ marginBottom: 10 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                            <span>Lift depth pivot</span>
                                            <span style={{ color: '#7bffb2', fontVariantNumeric: 'tabular-nums' }}>{liftDistancePivot.toFixed(1)}</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={-40}
                                            max={40}
                                            step={0.5}
                                            value={liftDistancePivot}
                                            onChange={(e) => updateArCalibration({ liftDistancePivot: parseFloat(e.target.value) })}
                                            style={{ width: '100%', accentColor: '#7bffb2' }}
                                        />
                                        <div style={{ fontSize: 9, opacity: 0.65, marginTop: 2 }}>
                                            Depth uses (pivot − lift); default 0 → deeper negative lift increases scale. Nudge pivot if ratios feel off.
                                        </div>
                                    </div>
                                )}
                                <div style={{ marginBottom: 8 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                        <span>Lift (Y offset)</span>
                                        <span style={{ color: '#7bffb2', fontVariantNumeric: 'tabular-nums' }}>{modelLift.toFixed(2)}</span>
                                    </div>
                                    <input
                                        type="range"
                                        min={-120}
                                        max={60}
                                        step={0.05}
                                        value={modelLift}
                                        onChange={(e) => {
                                            const newLift = parseFloat(e.target.value);
                                            setArCalibration((prev) => {
                                                if (!prev.compensateScaleWithLift) {
                                                    return { ...prev, modelLift: newLift };
                                                }
                                                const dOld = liftDepthForScreenCompensation(prev.liftDistancePivot, prev.modelLift);
                                                const dNew = liftDepthForScreenCompensation(prev.liftDistancePivot, newLift);
                                                const ratio = dNew / dOld;
                                                const clampS = (n: number) => Math.min(48, Math.max(0.2, n));
                                                return {
                                                    ...prev,
                                                    modelLift: newLift,
                                                    modelScaleX: clampS(prev.modelScaleX * ratio),
                                                    modelScaleY: clampS(prev.modelScaleY * ratio),
                                                    modelScaleZ: clampS(prev.modelScaleZ * ratio),
                                                };
                                            });
                                        }}
                                        style={{ width: '100%', accentColor: '#7bffb2' }}
                                    />
                                </div>
                                {([
                                    { key: 'modelBack', label: 'Back (Z offset)', min: -30, max: 30, step: 0.05 },
                                    { key: 'modelScaleX', label: 'Scale X', min: 0.5, max: 48, step: 0.05 },
                                    { key: 'modelScaleY', label: 'Scale Y', min: 0.5, max: 48, step: 0.05 },
                                    { key: 'modelScaleZ', label: 'Scale Z', min: 0.5, max: 48, step: 0.05 },
                                    { key: 'modelYawOffsetDeg', label: 'Yaw (°)', min: -180, max: 180, step: 0.5 },
                                    { key: 'modelPitchOffsetDeg', label: 'Pitch (°)', min: -180, max: 180, step: 0.5 },
                                    { key: 'modelRollOffsetDeg', label: 'Roll (°)', min: -180, max: 180, step: 0.5 },
                                    { key: 'sampleScaleFr', label: 'Sample scale', min: 0.005, max: 0.6, step: 0.001 },
                                ] as const).map(({ key, label, min, max, step }) => (
                                    <div key={key} style={{ marginBottom: 8 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                            <span>{label}</span>
                                            <span style={{ color: '#7bffb2', fontVariantNumeric: 'tabular-nums' }}>
                                                {(arCalibration[key] as number).toFixed(step < 0.01 ? 3 : 2)}
                                            </span>
                                        </div>
                                        <input
                                            type="range"
                                            min={min}
                                            max={max}
                                            step={step}
                                            value={arCalibration[key] as number}
                                            onChange={(e) => updateArCalibration({ [key]: parseFloat(e.target.value) } as Partial<ArCalibration>)}
                                            style={{ width: '100%', accentColor: '#7bffb2' }}
                                        />
                                    </div>
                                ))}
                                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                                    <button
                                        type="button"
                                        onClick={() => setArCalibration({ ...AR_CALIBRATION_DEFAULTS })}
                                        style={{
                                            flex: 1,
                                            padding: '6px 10px',
                                            borderRadius: 6,
                                            border: '1px solid rgba(255,255,255,0.25)',
                                            background: 'rgba(30, 38, 56, 0.8)',
                                            color: '#E6F2FF',
                                            fontSize: 11,
                                            fontWeight: 700,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        Reset
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const json = JSON.stringify(arCalibration, null, 2);
                                            if (navigator.clipboard) {
                                                navigator.clipboard.writeText(json).catch(() => {
                                                    console.log('[AR] calibration JSON:', json);
                                                });
                                            }
                                            console.log('[AR] calibration JSON:', json);
                                        }}
                                        style={{
                                            flex: 1,
                                            padding: '6px 10px',
                                            borderRadius: 6,
                                            border: '1px solid rgba(123,255,178,0.4)',
                                            background: 'rgba(28, 64, 46, 0.8)',
                                            color: '#7bffb2',
                                            fontSize: 11,
                                            fontWeight: 700,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        Copy JSON
                                    </button>
                                </div>
                                <div style={{ marginTop: 10, fontSize: 10, opacity: 0.7, lineHeight: 1.4 }}>
                                    Tip: physical-size match and “same pixels when deeper” are different goals — use the checkbox for presentation AR. True screen-constant size would need camera distance (not in this heuristic). Prefer uniform X/Y/Z scale for physics/rover fidelity.
                                </div>
                            </div>
                        )}

                        {/* Sample-collected popup (shared with web game) */}
                        {waypointPopup && (
                            <div
                                id="waypoint-popup"
                                role="dialog"
                                aria-modal="true"
                                onClick={() => setWaypointPopup(null)}
                            >
                                <div className="popup-container" onClick={(e) => e.stopPropagation()}>
                                    {waypointPopup.image && (
                                        <div className="popup-image-panel">
                                            <img src={waypointPopup.image} alt="Waypoint visual" />
                                        </div>
                                    )}
                                    <div className="popup-text-panel">
                                        <div className="waypoint-popup-title">{waypointPopup.title}</div>
                                        {waypointPopup.body && (
                                            <div className="waypoint-popup-body">{waypointPopup.body}</div>
                                        )}
                                        <div className="popup-hint">Click outside to close</div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* End screen */}
                        {showEndScreen && (
                            <div className="end-overlay" role="dialog" aria-modal="true">
                                <div className="end-modal">
                                    <h2 className="end-title">
                                        {endReason === 'complete' ? 'Mission Complete!' : 'Out of Energy'}
                                    </h2>
                                    <p className="end-subtitle">
                                        {endReason === 'complete'
                                            ? 'All samples have been recovered from the surface of Psyche.'
                                            : "Your rover's battery has been depleted. Mission over."}
                                    </p>
                                    <div className="end-stats">
                                        <div className="end-stat">
                                            <span className="end-stat-label">Samples Collected</span>
                                            <span className="end-stat-value">{samplesCollected} / {modeCfg.spawnSamples}</span>
                                        </div>
                                        {energyBonus > 0 && (
                                            <div className="end-stat">
                                                <span className="end-stat-label">Energy Bonus</span>
                                                <span className="end-stat-value">+{energyBonus}</span>
                                            </div>
                                        )}
                                        <div className="end-stat">
                                            <span className="end-stat-label">Final Score</span>
                                            <span className="end-stat-value">{score}</span>
                                        </div>
                                    </div>
                                    <button className="end-menu-btn" onClick={returnToMenu}>
                                        Return to Main Menu
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Intro briefing — only shown when launched with a difficulty. */}
                        {showIntroPopup && (
                            <div
                                className="intro-overlay"
                                onClick={() => { if (introPopupCanClose) closeIntroPopup(); }}
                                role="dialog"
                                aria-modal="true"
                            >
                                <div className="intro-modal" onClick={(e) => e.stopPropagation()}>
                                    <h2 className="intro-title">{INTRO_CONTENT[difficulty].welcome}</h2>
                                    <div className="intro-section">
                                        <h3 className="intro-section-heading">Controls</h3>
                                        <div className="intro-controls-grid">
                                            <span className="key-hint">W / A / S / D</span><span>Move rover</span>
                                            <span className="key-hint">Arrow Keys</span><span>Move rover</span>
                                            <span className="key-hint">D-pad</span><span>Move rover (mobile/touch)</span>
                                        </div>
                                    </div>
                                    <div className="intro-section">
                                        <p className="intro-description">{INTRO_CONTENT[difficulty].description}</p>
                                        <p className="intro-description" style={{ marginTop: '0.75rem', opacity: 0.9 }}>
                                            In AR, point the camera at your printed markers until the asteroid locks on, then use the same controls to drive across its surface.
                                        </p>
                                    </div>
                                    <button
                                        className={`intro-close-btn${introPopupCanClose ? '' : ' locked'}`}
                                        onClick={() => { if (introPopupCanClose) closeIntroPopup(); }}
                                        disabled={!introPopupCanClose}
                                    >
                                        {introPopupCanClose ? 'Begin Mission' : 'Reading...'}
                                    </button>
                                    {introPopupCanClose && (
                                        <p className="intro-dismiss-hint">Press Enter or click outside to dismiss</p>
                                    )}
                                </div>
                            </div>
                        )}

                        <div id="controls">
                            <div
                                className="dpad-circle"
                                onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); updateDpadFromPointer(e); }}
                                onPointerMove={(e) => { if (e.buttons) updateDpadFromPointer(e); }}
                                onPointerUp={(e) => { (e.target as HTMLElement).releasePointerCapture(e.pointerId); clearDpadInput(); }}
                                onPointerCancel={(e) => { (e.target as HTMLElement).releasePointerCapture(e.pointerId); clearDpadInput(); }}
                            />
                        </div>
                    </div>
                </>
            )}

            {gameState === 'WEB_GAME' && (
                <>
                    {/* Web Game Scene - hidden until rover is snapped to surface */}
                    <div style={{
                        position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0,
                        opacity: roverReady ? 1 : 0,
                        transition: 'opacity 0.15s ease-out'
                    }}>
                        <a-scene
                            embedded
                            vr-mode-ui="enabled: false"
                            background="color: #000011"
                        >
                            {/* Follow Camera */}
                            <a-camera
                                id="follow-camera"
                                position="0 0 5"
                                look-controls="enabled: false"
                                wasd-controls="enabled: false"
                            ></a-camera>

                            {/* Helper markers */}
                            <a-sphere position="0 0 0" radius="0.2" color="yellow"></a-sphere>
                            <a-text value="ORIGIN" position="0 0.5 0" scale="1 1 1" color="yellow" align="center"></a-text>

                            {/* Lighting */}
                            <a-light type="ambient" color="#FFFFFF" intensity="0.85"></a-light>
                            <a-light type="directional" color="#FFFFFF" intensity="1.0" position="3 5 4"></a-light>
                            <a-light type="directional" color="#E8E8FF" intensity="0.6" position="-2 -3 -4"></a-light>
                            <a-light type="point" color="#FFFFFF" intensity="0.4" position="-3 2 3"></a-light>
                            <a-light type="point" color="#FFFFFF" intensity="0.4" position="0 -2 -5"></a-light>

                            {/* Space background — stars distributed across full surrounding sphere */}
                            <a-entity>
                                {STARS.map(s => (
                                    <a-sphere
                                        key={s.id}
                                        position={s.pos}
                                        radius={s.radius}
                                        color={s.color}
                                        opacity={s.opacity}
                                        material="shader: flat"
                                        animation={`property: scale; from: 1 1 1; to: 1.1 1.1 1.1; loop: true; dir: alternate; dur: ${s.dur}; delay: ${s.delay}; easing: easeInOutSine`}
                                        animation__opacity={`property: material.opacity; from: ${s.opacity}; to: ${(s.opacity * 0.3).toFixed(2)}; loop: true; dir: alternate; dur: ${Math.round(s.dur * 0.7)}; delay: ${s.delay}; easing: easeInOutSine`}
                                    ></a-sphere>
                                ))}
                            </a-entity>

                            {/* VISUAL ASTEROID */}
                            <a-entity
                                id="asteroid"
                                position="0 0 0"
                                rotation="0 0 0"
                            >
                                <a-gltf-model
                                    id="asteroid-model"
                                    src="./models/AsteroidPsyche.glb"
                                    scale="2.5 2.5 2.5"
                                    position="-3.75 -2.2 3.22"
                                ></a-gltf-model>
                            </a-entity>

                            {/* COLLISION MESH - hidden (only used by Rust raycasting) */}
                            <a-entity
                                id="collision-viz"
                                position="0 0 0"
                                rotation="0 0 0"
                                visible="false"
                            >
                                <a-gltf-model
                                    src="./models/AsteroidPsyche_Collision.glb"
                                    scale="2.5 2.5 2.5"
                                    position="-3.75 -2.2 3.22"
                                ></a-gltf-model>
                            </a-entity>

                            {/* Samples (collectibles) */}
                            {samples.map(s => (
                                <a-entity key={s.id} position={`${s.x} ${s.y} ${s.z}`} rotation={s.rotation}>
                                    <a-gltf-model src={`./models/${s.model}.glb`} scale="0.2 0.2 0.2" />
                                </a-entity>
                            ))}

                            {/* Obstacles (visual only) */}
                            {obstacles.map(o => (
                                <a-entity key={o.id} position={`${o.x} ${o.y} ${o.z}`}>
                                    <a-sphere radius={o.radius} color="#ff4d4d" material="transparent: true; opacity: 0.6" />
                                </a-entity>
                            ))}

                            {/* Sample indicator arrow — orbits rover in tangent plane toward nearest sample */}
                            <a-entity id="sample-arrow" visible="false">
                                <a-entity animation="property: scale; from: 1 1 1; to: 1.35 1.35 1.35; loop: true; dir: alternate; dur: 500; easing: easeInOutSine">
                                    {/* Arrowhead */}
                                    <a-cone
                                        height="0.09"
                                        radius-bottom="0.05"
                                        radius-top="0"
                                        color="#FFD700"
                                        position="0 0.1 0"
                                        material="emissive: #FFD700; emissiveIntensity: 0.55; transparent: true; opacity: 0.95"
                                        animation="property: material.opacity; from: 0.95; to: 0.3; loop: true; dir: alternate; dur: 500; easing: easeInOutSine"
                                    />
                                    {/* Shaft */}
                                    <a-cylinder
                                        radius="0.013"
                                        height="0.11"
                                        color="#FFD700"
                                        position="0 0.02 0"
                                        material="emissive: #FFD700; emissiveIntensity: 0.35; transparent: true; opacity: 0.8"
                                        animation="property: material.opacity; from: 0.8; to: 0.2; loop: true; dir: alternate; dur: 500; easing: easeInOutSine"
                                    />
                                </a-entity>
                            </a-entity>

                            {/* Rover */}
                            <a-entity
                                id="rover"
                                position="0 0 3.3"
                                rotation="0 0 0"
                                scale="0.25 0.25 0.25"
                                visible={roverReady ? "true" : "false"}
                            >
                                {/* TREADS */}
                                <a-box width="0.1" height="0.16" depth="0.52" color="#2A2A2A" position="-0.25 -0.04 0"></a-box>
                                <a-box width="0.1" height="0.16" depth="0.52" color="#2A2A2A" position="0.25 -0.04 0"></a-box>
                                <a-cylinder radius="0.08" height="0.1" rotation="0 0 90" color="#3A3A3A" position="-0.25 -0.04 -0.2"></a-cylinder>
                                <a-cylinder radius="0.08" height="0.1" rotation="0 0 90" color="#3A3A3A" position="-0.25 -0.04 0.2"></a-cylinder>
                                <a-cylinder radius="0.08" height="0.1" rotation="0 0 90" color="#3A3A3A" position="0.25 -0.04 -0.2"></a-cylinder>
                                <a-cylinder radius="0.08" height="0.1" rotation="0 0 90" color="#3A3A3A" position="0.25 -0.04 0.2"></a-cylinder>

                                {/* BODY */}
                                <a-box width="0.4" height="0.32" depth="0.36" color="#B8963E" position="0 0.14 0"></a-box>
                                <a-box width="0.38" height="0.28" depth="0.01" color="#8B7230" position="0 0.15 -0.18"></a-box>
                                <a-box width="0.38" height="0.28" depth="0.01" color="#8B7230" position="0 0.15 0.18"></a-box>
                                <a-box width="0.42" height="0.02" depth="0.38" color="#9E8438" position="0 0.31 0"></a-box>

                                {/* NECK */}
                                <a-cylinder radius="0.025" height="0.18" color="#707070" position="0 0.41 -0.04"></a-cylinder>
                                <a-cylinder radius="0.025" height="0.18" color="#707070" position="0 0.41 -0.04" rotation="0 0 6"></a-cylinder>

                                {/* HEAD */}
                                <a-box width="0.26" height="0.07" depth="0.07" color="#606060" position="0 0.52 -0.06"></a-box>
                                <a-cylinder radius="0.055" height="0.14" rotation="90 0 0" color="#505050" position="-0.08 0.52 -0.14"></a-cylinder>
                                <a-cylinder radius="0.055" height="0.14" rotation="90 0 0" color="#505050" position="0.08 0.52 -0.14"></a-cylinder>
                                <a-cylinder radius="0.058" height="0.02" rotation="90 0 0" color="#404040" position="-0.08 0.52 -0.21"></a-cylinder>
                                <a-cylinder radius="0.058" height="0.02" rotation="90 0 0" color="#404040" position="0.08 0.52 -0.21"></a-cylinder>

                                {/* EYE LENSES */}
                                <a-sphere radius="0.048" color="#6DB8D4" position="-0.08 0.52 -0.22"></a-sphere>
                                <a-sphere radius="0.048" color="#6DB8D4" position="0.08 0.52 -0.22"></a-sphere>
                                <a-sphere radius="0.025" color="#1A1A1A" position="-0.08 0.52 -0.25"></a-sphere>
                                <a-sphere radius="0.025" color="#1A1A1A" position="0.08 0.52 -0.25"></a-sphere>

                                {/* ARMS */}
                                <a-box width="0.035" height="0.035" depth="0.18" color="#707070" rotation="15 0 0" position="-0.24 0.14 -0.14"></a-box>
                                <a-box width="0.035" height="0.035" depth="0.18" color="#707070" rotation="15 0 0" position="0.24 0.14 -0.14"></a-box>
                                <a-box width="0.06" height="0.02" depth="0.06" color="#606060" rotation="15 0 0" position="-0.24 0.14 -0.25"></a-box>
                                <a-box width="0.06" height="0.02" depth="0.06" color="#606060" rotation="15 0 0" position="0.24 0.14 -0.25"></a-box>

                                {/* SOLAR PANEL */}
                                <a-box width="0.08" height="0.02" depth="0.2" color="#555555" position="0 0.33 0"></a-box>
                            </a-entity>
                        </a-scene>
                    </div>

                    <div id="ui-overlay" style={{ display: 'block' }}>
                        <div id="score-display">
                            SCORE <span id="score">{score}</span>
                        </div>
                        <div className="mode-ui">
                            {modeCfg.energyEnabled && <div className="energy-display">ENERGY <div className="energy-bar"><div style={{ width: `${(energy / MAX_ENERGY) * 100}%` }} /></div></div>}
                            <div className="samples-display">SAMPLES <span style={{ color: '#7bffb2', fontWeight: 800 }}>{samplesCollected}</span></div>
                        </div>
                        {/* WAYPOINT POPUP */}
                        {waypointPopup && (
                            <div
                                id="waypoint-popup"
                                role="dialog"
                                aria-modal="true"
                                onClick={() => setWaypointPopup(null)}
                            >
                                <div
                                    className="popup-container"
                                    /* Closes the popup on click */
                                    onClick={(e) => e.stopPropagation()}
                                >

                                    {waypointPopup.image && (
                                        <div className="popup-image-panel">
                                            <img src={waypointPopup.image} alt="Waypoint visual" />
                                        </div>
                                    )}

                                    <div className="popup-text-panel">
                                        <div className="waypoint-popup-title">{waypointPopup.title}</div>

                                        {waypointPopup.body && (
                                            <div className="waypoint-popup-body">{waypointPopup.body}</div>
                                        )}

                                        <div className="popup-hint">Click outside to close</div>
                                    </div>
                                </div>
                            </div>
                        )}
                        {/* END SCREEN */}
                        {showEndScreen && (
                            <div className="end-overlay" role="dialog" aria-modal="true">
                                <div className="end-modal">
                                    <h2 className="end-title">
                                        {endReason === 'complete' ? 'Mission Complete!' : 'Out of Energy'}
                                    </h2>
                                    <p className="end-subtitle">
                                        {endReason === 'complete'
                                            ? 'All samples have been recovered from the surface of Psyche.'
                                            : "Your rover's battery has been depleted. Mission over."}
                                    </p>

                                    <div className="end-stats">
                                        <div className="end-stat">
                                            <span className="end-stat-label">Samples Collected</span>
                                            <span className="end-stat-value">{samplesCollected} / {modeCfg.spawnSamples}</span>
                                        </div>
                                        {energyBonus > 0 && (
                                            <div className="end-stat">
                                                <span className="end-stat-label">Energy Bonus</span>
                                                <span className="end-stat-value">+{energyBonus}</span>
                                            </div>
                                        )}
                                        <div className="end-stat">
                                            <span className="end-stat-label">Final Score</span>
                                            <span className="end-stat-value">{score}</span>
                                        </div>
                                    </div>

                                    <button className="end-menu-btn" onClick={returnToMenu}>
                                        Return to Main Menu
                                    </button>
                                </div>
                            </div>
                        )}
                        {/* INTRO POPUP */}
                        {showIntroPopup && (
                            <div
                                className="intro-overlay"
                                onClick={() => { if (introPopupCanClose) closeIntroPopup(); }}
                                role="dialog"
                                aria-modal="true"
                            >
                                <div className="intro-modal" onClick={(e) => e.stopPropagation()}>
                                    <h2 className="intro-title">{INTRO_CONTENT[difficulty].welcome}</h2>

                                    <div className="intro-section">
                                        <h3 className="intro-section-heading">Controls</h3>
                                        <div className="intro-controls-grid">
                                            <span className="key-hint">W / A / S / D</span><span>Move rover</span>
                                            <span className="key-hint">Arrow Keys</span><span>Move rover</span>
                                            <span className="key-hint">D-pad</span><span>Move rover (mobile/touch)</span>
                                        </div>
                                    </div>

                                    <div className="intro-section">
                                        <p className="intro-description">{INTRO_CONTENT[difficulty].description}</p>
                                    </div>

                                    <button
                                        className={`intro-close-btn${introPopupCanClose ? '' : ' locked'}`}
                                        onClick={() => { if (introPopupCanClose) closeIntroPopup(); }}
                                        disabled={!introPopupCanClose}
                                    >
                                        {introPopupCanClose ? 'Begin Mission' : 'Reading...'}
                                    </button>
                                    {introPopupCanClose && (
                                        <p className="intro-dismiss-hint">Press Enter or click outside to dismiss</p>
                                    )}
                                </div>
                            </div>
                        )}
                        <div id="controls">
                            <div
                                className="dpad-circle"
                                onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); updateDpadFromPointer(e); }}
                                onPointerMove={(e) => { if (e.buttons) updateDpadFromPointer(e); }}
                                onPointerUp={(e) => { (e.target as HTMLElement).releasePointerCapture(e.pointerId); clearDpadInput(); }}
                                onPointerCancel={(e) => { (e.target as HTMLElement).releasePointerCapture(e.pointerId); clearDpadInput(); }}
                            />
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default App;
