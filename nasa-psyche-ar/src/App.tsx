/**
 * NASA Psyche AR — Web/AR rover exploration experience.
 * Uses React + A-Frame for 3D, Rust/WASM for collision and movement.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import MODE_CONFIG, { Difficulty } from './modeConfig';
// @ts-ignore
import init, { load_collision_mesh, move_rover_on_asteroid, get_surface_point_in_direction } from '../rust_engine/pkg/rust_engine';

/** Converts surface normal (nx, ny, nz) to A-Frame Euler rotation string for cylinder alignment. */
const rotationFromNormal = (nx: number, ny: number, nz: number): string => {
    const THREE = (window as any).THREE;
    if (!THREE) return "0 0 0";
    const y = new THREE.Vector3(nx, ny, nz).normalize();
    let z = new THREE.Vector3(0, 0, 1);
    if (Math.abs(y.dot(z)) > 0.99) z.set(1, 0, 0);
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    z = new THREE.Vector3().crossVectors(x, y).normalize();
    const m = new THREE.Matrix4().makeBasis(x, y, z);
    const e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ');
    return `${e.x * 180 / Math.PI} ${e.y * 180 / Math.PI} ${e.z * 180 / Math.PI}`;
};

/** World-space directions for raycasting waypoint positions on the asteroid surface. */
const WAYPOINT_DIRECTIONS: [number, number, number][] = [
    [0.707, 0, 0.707], [-0.707, 0.2, 0.707], [0, 0.707, 0.707], [0, -0.707, 0.707],
    [0.707, 0.707, 0], [-0.707, 0.5, -0.5], [0, 0, -1], [0.5, -0.707, -0.5],
];

const App = () => {
    const [gameState, setGameState] = useState('MENU');
    const [score, setScore] = useState(0);
    const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal');
    const modeCfg = MODE_CONFIG[difficulty as Difficulty];
    // Samples (collectibles) and Obstacles
    const [samples, setSamples] = useState<{ id: string; x: number; y: number; z: number }[]>([]);
    const samplesRef = useRef<typeof samples>([]);
    samplesRef.current = samples;
    const [samplesCollected, setSamplesCollected] = useState(0);

    const [obstacles, setObstacles] = useState<{ id: string; x: number; y: number; z: number }[]>([]);
    const obstaclesRef = useRef<typeof obstacles>([]);
    obstaclesRef.current = obstacles;

    // Energy meter (0..100) - skeleton only
    const [energy, setEnergy] = useState(100);
    const [showDifficulty, setShowDifficulty] = useState(false);
    
    const [scanPrompt, setScanPrompt] = useState(true);
    const [meshLoaded, setMeshLoaded] = useState(false);
    const [roverReady, setRoverReady] = useState(false);
    const [waypoints, setWaypoints] = useState<{ id: string; x: number; y: number; z: number; nx: number; ny: number; nz: number }[]>([]);
    const lastDirectionRef = useRef<[number, number]>([0, 1]);
    const waypointsRef = useRef<{ id: string; x: number; y: number; z: number; nx: number; ny: number; nz: number }[]>([]);
    waypointsRef.current = waypoints;
    const keysHeld = useRef(new Set<string>());
    const dpadInputRef = useRef<[number, number]>([0, 0]);
    const moveLoopId = useRef<number | null>(null);
    const lastMoveTime = useRef(0);
    const prevCamUp = useRef<any>(null);
    // Keyboard navigation
    const playBtnRef = useRef<HTMLButtonElement | null>(null);
    const arBtnRef = useRef<HTMLButtonElement | null>(null);
    const diffBtnRefs = [useRef<HTMLButtonElement | null>(null), useRef<HTMLButtonElement | null>(null), useRef<HTMLButtonElement | null>(null)];

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

    const handleStart = async (mode: string, chosenDifficulty?: 'easy' | 'normal' | 'hard') => {
        if (chosenDifficulty) setDifficulty(chosenDifficulty);

        if (mode === 'web_game') {
            console.log("Starting WEB GAME MODE", chosenDifficulty);
            setGameState('WEB_GAME');
        } else if (mode === 'ar') {
            console.log("Starting AR MODE");
            setGameState('AR_MODE');
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

    /** Advances rover one step: projects input onto tangent plane, raycasts to surface, updates position and camera. */
    const moveRover = useCallback((inputX: number, inputY: number) => {
        if (gameState !== 'WEB_GAME' && gameState !== 'AR_MODE') return;

        const THREE = (window as any).THREE;
        const rover = document.getElementById('rover') as any;
        if (!THREE || !rover) return;

        const currentPos = rover.getAttribute('position');
        lastDirectionRef.current = [inputX, inputY];

        /* Convert screen-space input to world-space direction via camera frame. */
        const { right, up } = getCameraFrame(currentPos.x, currentPos.y, currentPos.z);
        const moveDir = up.clone().multiplyScalar(inputY).addScaledVector(right, inputX);

        try {
            const result = move_rover_on_asteroid(
                moveDir.x, moveDir.y, moveDir.z,
                currentPos.x, currentPos.y, currentPos.z
            );

            rover.setAttribute('position', {
                x: result.position[0],
                y: result.position[1],
                z: result.position[2]
            });

            updateRoverRotation(rover, result.position[0], result.position[1], result.position[2], moveDir.x, moveDir.y, moveDir.z);
            updateCamera(result.position[0], result.position[1], result.position[2]);

            /* Check waypoint collection within radius (waypoints + samples). */
            const COLLECTION_RADIUS = 0.25;
            const rx = result.position[0], ry = result.position[1], rz = result.position[2];
            const wps = waypointsRef.current;
            const collected = wps.filter(wp => {
                const dx = wp.x - rx, dy = wp.y - ry, dz = wp.z - rz;
                return dx * dx + dy * dy + dz * dz < COLLECTION_RADIUS * COLLECTION_RADIUS;
            });
            if (collected.length > 0) {
                setWaypoints(prev => prev.filter(wp => !collected.find(c => c.id === wp.id)));
                setScore(s => s + collected.length * 100);
            }
            // samples
            const sps = samplesRef.current;
            const collectedSamples = sps.filter(s => {
                const dx = s.x - rx, dy = s.y - ry, dz = s.z - rz;
                return dx * dx + dy * dy + dz * dz < COLLECTION_RADIUS * COLLECTION_RADIUS;
            });
            if (collectedSamples.length > 0) {
                setSamples(prev => prev.filter(s => !collectedSamples.find(c => c.id === s.id)));
                setSamplesCollected(c => c + collectedSamples.length);
                setScore(s => s + collectedSamples.length * 150);
            }
        } catch (e) {
            console.error("Movement error:", e);
        }
    }, [gameState]);

    /**
     * Global keyboard handlers
     */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && showDifficulty) {
                setShowDifficulty(false);
            }
        };

        window.addEventListener('keydown', onKey);

        return () => window.removeEventListener('keydown', onKey);
    }, [showDifficulty]);

    useEffect(() => {
        if (showDifficulty) {
            // focus first difficulty button when opening
            setTimeout(() => diffBtnRefs[0].current?.focus(), 50);
        } else {
            // return focus to Launch Mission button when closing
            setTimeout(() => playBtnRef.current?.focus(), 50);
        }
    }, [showDifficulty]);

    /**
     * Trap Tab focus inside the start screen when on MENU and modal is closed.
     * This prevents Tab from moving focus out of the app's start UI.
     */
    useEffect(() => {
        if (gameState !== 'MENU' || showDifficulty) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            const order: HTMLElement[] = [];
            if (playBtnRef.current && !playBtnRef.current.hasAttribute('disabled')) order.push(playBtnRef.current);
            if (arBtnRef.current) order.push(arBtnRef.current);
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
    }, [gameState, showDifficulty]);

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
        const MOVE_INTERVAL = 33;
        if (timestamp - lastMoveTime.current >= MOVE_INTERVAL) {
            lastMoveTime.current = timestamp;

            const k = keysHeld.current;
            const [padX, padY] = dpadInputRef.current;
            let inputX = padX;
            let inputY = padY;
            if (k.has('w') || k.has('arrowup'))    inputY += 1;
            if (k.has('s') || k.has('arrowdown'))  inputY -= 1;
            if (k.has('a') || k.has('arrowleft'))  inputX -= 1;
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

    /** On game start: reset state and spawn waypoints/samples/obstacles for gameplay modes. */
    useEffect(() => {
        if (gameState === 'WEB_GAME' || gameState === 'AR_MODE') {
            setRoverReady(false);
            setScore(0);
            setSamplesCollected(0);
            prevCamUp.current = null;
            if (meshLoaded) {
                // spawn waypoints and collectibles for both WEB_GAME and AR_MODE
                const wps: { id: string; x: number; y: number; z: number; nx: number; ny: number; nz: number }[] = [];
                WAYPOINT_DIRECTIONS.forEach(([dx, dy, dz], i) => {
                    try {
                        const r = get_surface_point_in_direction(dx, dy, dz);
                        wps.push({
                            id: `wp-${i}`,
                            x: r.position[0], y: r.position[1], z: r.position[2],
                            nx: r.normal[0], ny: r.normal[1], nz: r.normal[2]
                        });
                    } catch (_) { /* Raycast missed; skip this waypoint. */ }
                });
                setWaypoints(wps);

                // Samples
                const sampleList: { id: string; x: number; y: number; z: number }[] = [];
                for (let i = 0; i < modeCfg.spawnSamples; i++) {
                    const dir = WAYPOINT_DIRECTIONS[i % WAYPOINT_DIRECTIONS.length];
                    try {
                        const r = get_surface_point_in_direction(dir[0], dir[1], dir[2]);
                        sampleList.push({ id: `s-${i}`, x: r.position[0], y: r.position[1], z: r.position[2] });
                    } catch (_) { }
                }
                setSamples(sampleList);

                // Obstacles (visual only for now)
                const obsList: { id: string; x: number; y: number; z: number }[] = [];
                for (let i = 0; i < modeCfg.spawnObstacles; i++) {
                    const dir = WAYPOINT_DIRECTIONS[(i + 3) % WAYPOINT_DIRECTIONS.length];
                    try {
                        const r = get_surface_point_in_direction(dir[0], dir[1], dir[2]);
                        obsList.push({ id: `o-${i}`, x: r.position[0], y: r.position[1], z: r.position[2] });
                    } catch (_) { }
                }
                setObstacles(obsList);

                // Energy meter (skeleton): initialize to full. Implementation left for later.
                setEnergy(100);
            } else {
                setWaypoints([]);
                setSamples([]);
                setObstacles([]);
            }
        }
    }, [gameState, meshLoaded]);

    /** Keyboard listeners and rover init: snap to surface before revealing scene. */
    useEffect(() => {
        if ((gameState !== 'WEB_GAME' && gameState !== 'AR_MODE') || !meshLoaded) {
            return () => {};
        }

        const initRover = () => {
            const rover = document.getElementById('rover') as any;
            if (!rover) return;

            try {
                const pos = rover.getAttribute('position');
                const result = move_rover_on_asteroid(0, 0, 0, pos.x, pos.y, pos.z);

                rover.setAttribute('position', {
                    x: result.position[0],
                    y: result.position[1],
                    z: result.position[2]
                });

                const [ix, iy] = lastDirectionRef.current;
                const { right, up } = getCameraFrame(result.position[0], result.position[1], result.position[2]);
                const dir = up.clone().multiplyScalar(iy).addScaledVector(right, ix);
                updateRoverRotation(rover, result.position[0], result.position[1], result.position[2], dir.x, dir.y, dir.z);
                updateCamera(result.position[0], result.position[1], result.position[2]);

                setRoverReady(true);
            } catch (e) {
                console.error("Rover init failed:", e);
                setTimeout(initRover, 100);
            }
        };

        const t = setTimeout(initRover, 50);

        const validKeys = new Set(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright']);

            const onKeyDown = (e: KeyboardEvent) => {
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
            clearTimeout(t);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            if (moveLoopId.current !== null) {
                cancelAnimationFrame(moveLoopId.current);
                moveLoopId.current = null;
            }
            keysHeld.current.clear();
        };
    }, [gameState, meshLoaded, movementLoop]);

    /** AR mode: show/hide scan prompt based on marker visibility. */
    useEffect(() => {
        if (gameState === 'AR_MODE') {
            const arTarget = document.getElementById('ar-target');
            if (arTarget) {
                const onFound = () => {
                    console.log("AR Marker found!");
                    setScanPrompt(false);
                };
                const onLost = () => {
                    console.log("AR Marker lost");
                    setScanPrompt(true);
                };
                arTarget.addEventListener('targetFound', onFound);
                arTarget.addEventListener('targetLost', onLost);
                return () => {
                    arTarget.removeEventListener('targetFound', onFound);
                    arTarget.removeEventListener('targetLost', onLost);
                };
            }
        }
        return () => {};
    }, [gameState]);

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
                        <div className="badge-label">NASA Capstone Project</div>
                    </div>
                    <h1>Psyche</h1>
                    <p className="subtitle">Explore • Navigate • Discover</p>
                    <div className="button-container">
                        <button id="play-button" ref={playBtnRef} onClick={() => setShowDifficulty(true)} disabled={!meshLoaded}>
                            {meshLoaded ? 'Launch Mission' : 'Loading...'}
                        </button>
                        <button id="start-button" ref={arBtnRef} onClick={() => handleStart('ar')}>AR Experience</button>
                    </div>
                    <div className={`difficulty-overlay ${showDifficulty ? 'open' : 'closed'}`} onClick={() => setShowDifficulty(false)}>
                        <div className="difficulty-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-hidden={!showDifficulty}>
                            <h2 className="difficulty-title">Select Difficulty</h2>
                            <p className="difficulty-sub">Choose how challenging the mission will be.</p>

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
                                <button ref={diffBtnRefs[0]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart('web_game','easy'); }}>Easy</button>
                                <button ref={diffBtnRefs[1]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart('web_game','normal'); }}>Normal</button>
                                <button ref={diffBtnRefs[2]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart('web_game','hard'); }}>Hard</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {gameState === 'AR_MODE' && (
                <>
                    {/* AR Scene with Camera Access */}
                    <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}>
                        <a-scene
                            mindar-image="imageTargetSrc: ./markers/4x4_1000-0.mind; uiLoading: no; uiScanning: no; uiError: no;"
                            color-space="sRGB"
                            renderer="colorManagement: true"
                            vr-mode-ui="enabled: false"
                            device-orientation-permission-ui="enabled: false"
                        >
                            <a-camera position="0 0 0" look-controls="enabled: false"></a-camera>

                            <a-entity id="ar-target" mindar-image-target="targetIndex: 0">
                                {/* Asteroid - scaled for AR marker */}
                                <a-entity position="0 0 0" rotation="0 0 0">
                                    <a-gltf-model 
                                        src="./models/AsteroidPsyche.glb" 
                                        scale="2.5 2.5 2.5"
                                        position="-3.75 -2.2 3.22"
                                    ></a-gltf-model>
                                </a-entity>

                                {/* Gameplay entities in AR mode */}
                                {waypoints.map((wp) => {
                                    const h = 0.5;
                                    const cx = 0.5 * wp.nx, cy = 0.5 * wp.ny, cz = 0.5 * wp.nz;
                                    return (
                                        <a-entity key={wp.id} position={`${wp.x} ${wp.y} ${wp.z}`}>
                                            <a-sphere radius="0.04" color="#FFD700" material="transparent: true; opacity: 0.7" />
                                            <a-cylinder
                                                radius="0.015"
                                                height={h}
                                                color="#FFD700"
                                                material="transparent: true; opacity: 0.6"
                                                position={`${cx * 0.5} ${cy * 0.5} ${cz * 0.5}`}
                                                rotation={rotationFromNormal(wp.nx, wp.ny, wp.nz)}
                                            />
                                        </a-entity>
                                    );
                                })}

                                {samples.map(s => (
                                    <a-entity key={s.id} position={`${s.x} ${s.y} ${s.z}`}>
                                        <a-sphere radius="0.05" color="#7bffb2" material="transparent: true; opacity: 0.95" />
                                    </a-entity>
                                ))}

                                {obstacles.map(o => (
                                    <a-entity key={o.id} position={`${o.x} ${o.y} ${o.z}`}>
                                        <a-sphere radius="0.06" color="#ff4d4d" material="transparent: true; opacity: 0.95" />
                                    </a-entity>
                                ))}

                                {/* Rover on asteroid */}
                                <a-entity id="rover" position="0 0 3.3" rotation="0 0 0">
                                    <a-box width="0.32" height="0.2" depth="0.26" color="#B8963E"></a-box>
                                    <a-cylinder radius="0.06" height="0.08" rotation="0 0 90" color="#333" position="-0.16 -0.09 -0.1"></a-cylinder>
                                    <a-cylinder radius="0.06" height="0.08" rotation="0 0 90" color="#333" position="-0.16 -0.09 0.1"></a-cylinder>
                                    <a-cylinder radius="0.06" height="0.08" rotation="0 0 90" color="#333" position="0.16 -0.09 -0.1"></a-cylinder>
                                    <a-cylinder radius="0.06" height="0.08" rotation="0 0 90" color="#333" position="0.16 -0.09 0.1"></a-cylinder>
                                    <a-box width="0.16" height="0.06" depth="0.08" color="#606060" position="0 0.13 -0.03"></a-box>
                                </a-entity>
                            </a-entity>
                        </a-scene>
                    </div>

                    <div id="ui-overlay" style={{ display: 'block' }}>
                        {scanPrompt && (
                            <div id="scan-prompt">
                                Point camera at printed 4x4_1000-0-mind-target.png
                            </div>
                        )}

                        <div id="score-display">
                            SCORE <span id="score">{score}</span>
                        </div>

                        <div className="mode-ui">
                            <div className="energy-display">ENERGY <div className="energy-bar"><div style={{ width: `${energy}%` }} /></div></div>
                            <div className="samples-display">SAMPLES <span style={{ color: '#7bffb2', fontWeight: 800 }}>{samplesCollected}</span></div>
                        </div>

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
                    {/* Mode banner shows active mode and difficulty */}
                    <div className="mode-banner">WEB GAME — {difficulty.toUpperCase()}</div>
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

                            {/* Space background */}
                            <a-entity>
                                <a-sphere position="8 5 -12" radius="0.08" color="#FFFFFF"></a-sphere>
                                <a-sphere position="-9 6 -15" radius="0.06" color="#FFFFFF"></a-sphere>
                                <a-sphere position="10 -4 -13" radius="0.07" color="#FFFFFF"></a-sphere>
                                <a-sphere position="-8 -5 -11" radius="0.05" color="#FFFFFF"></a-sphere>
                                <a-sphere position="7 8 -16" radius="0.06" color="#00d4ff" opacity="0.8"></a-sphere>
                                <a-sphere position="-10 3 -14" radius="0.08" color="#7b2cbf" opacity="0.7"></a-sphere>
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

                            {/* Waypoints */}
                            {waypoints.map((wp) => {
                                const h = 0.5;
                                const cx = 0.5 * wp.nx, cy = 0.5 * wp.ny, cz = 0.5 * wp.nz;
                                return (
                                    <a-entity key={wp.id} position={`${wp.x} ${wp.y} ${wp.z}`}>
                                        <a-sphere radius="0.04" color="#FFD700" material="transparent: true; opacity: 0.7" />
                                        <a-cylinder
                                            radius="0.015"
                                            height={h}
                                            color="#FFD700"
                                            material="transparent: true; opacity: 0.6"
                                            position={`${cx * 0.5} ${cy * 0.5} ${cz * 0.5}`}
                                            rotation={rotationFromNormal(wp.nx, wp.ny, wp.nz)}
                                        />
                                    </a-entity>
                                );
                            })}

                            {/* Samples (collectibles) */}
                            {samples.map(s => (
                                <a-entity key={s.id} position={`${s.x} ${s.y} ${s.z}`}>
                                    <a-sphere radius="0.05" color="#7bffb2" material="transparent: true; opacity: 0.95" />
                                </a-entity>
                            ))}

                            {/* Obstacles (visual only) */}
                            {obstacles.map(o => (
                                <a-entity key={o.id} position={`${o.x} ${o.y} ${o.z}`}>
                                    <a-sphere radius="0.06" color="#ff4d4d" material="transparent: true; opacity: 0.95" />
                                </a-entity>
                            ))}

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
                            <div className="energy-display">ENERGY <div className="energy-bar"><div style={{ width: `${energy}%` }} /></div></div>
                            <div className="samples-display">SAMPLES <span style={{ color: '#7bffb2', fontWeight: 800 }}>{samplesCollected}</span></div>
                        </div>

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
