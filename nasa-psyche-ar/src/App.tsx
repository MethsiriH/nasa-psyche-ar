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
const WAYPOINT_DIRECTIONS: [number, number, number][] = [
    [0.707, 0, 0.707], [-0.707, 0.2, 0.707], [0, 0.707, 0.707], [0, -0.707, 0.707],
    [0.707, 0.707, 0], [-0.707, 0.5, -0.5], [0, 0, -1], [0.5, -0.707, -0.5],
];

const INTRO_CONTENT: Record<string, { welcome: string; description: string }> = {
    easy: {
        welcome: 'Welcome to Story Mode',
        description: 'Explore the surface of asteroid Psyche with complete freedom. Pilot the rover across the terrain and drive over samples to collect them. If you ever get lost, follow the indicator arrow to the nearest sample.',
    },
    normal: {
        welcome: 'Welcome to Normal Mode',
        description: "Explore Psyche with the energy system in play. Your rover's battery drains as you roam — collect samples efficiently before power runs out. Follow the indicator arrow if you lose track of your next sample. The mission ends when you collect all 20 samples or run out of energy.",
    },
    hard: {
        welcome: 'Welcome to Hard Mode',
        description: "Psyche is at its most unforgiving. Energy drains your battery, and craters larger than the rover are scattered across the surface — driving into one cuts your speed in half. Navigate carefully, collect samples quickly, and use the indicator arrow wisely. The mission ends when you collect all 20 samples or run out of energy.",
    },
};

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
    const [showCredits, setShowCredits] = useState(false);
    const [showIntroPopup, setShowIntroPopup] = useState(false);
    const [introPopupCanClose, setIntroPopupCanClose] = useState(false);
    const showIntroPopupRef = useRef(false);
    showIntroPopupRef.current = showIntroPopup;
    const introLockoutTimerRef = useRef<number | null>(null);
    const [showEndScreen, setShowEndScreen] = useState(false);
    const [endReason, setEndReason] = useState<'complete' | 'energy'>('complete');

    // Centralized difficulty configuration placeholder.

    const difficultyConfig: Record<string, any> = {
        easy: { spawnCount: 4, scoreMultiplier: 0.8 },
        normal: { spawnCount: 6, scoreMultiplier: 1.0 },
        hard: { spawnCount: 8, scoreMultiplier: 1.25 },
    };
    const [scanPrompt, setScanPrompt] = useState(true);
    const [meshLoaded, setMeshLoaded] = useState(false);
    const [roverReady, setRoverReady] = useState(false);
    const lastDirectionRef = useRef<[number, number]>([0, 1]);
    const keysHeld = useRef(new Set<string>());
    const dpadInputRef = useRef<[number, number]>([0, 0]);
    const moveLoopId = useRef<number | null>(null);
    const lastMoveTime = useRef(0);
    const prevCamUp = useRef<any>(null);
    const energyRef = useRef(100);
    energyRef.current = energy;
    const modeCfgRef = useRef(modeCfg);
    modeCfgRef.current = modeCfg;
    // Keyboard navigation
    const playBtnRef = useRef<HTMLButtonElement | null>(null);
    const arBtnRef = useRef<HTMLButtonElement | null>(null);
    const creditsBtnRef = useRef<HTMLButtonElement | null>(null);
    const diffBtnRefs = [useRef<HTMLButtonElement | null>(null), useRef<HTMLButtonElement | null>(null), useRef<HTMLButtonElement | null>(null)];
    const [waypointPopup, setWaypointPopup] = useState<{ title: string; body?: string; image?: string; } | null>(null);

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
        setSamplesCollected(0);
        setScore(0);
        energyRef.current = 100;
        setEnergy(100);
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
            console.log("Starting AR MODE");
            setGameState('AR_MODE');
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

    let popupIndex = 0;

    /** Advances rover one step: projects input onto tangent plane, raycasts to surface, updates position and camera. */
    const moveRover = useCallback((inputX: number, inputY: number) => {
        if (gameState !== 'WEB_GAME' && gameState !== 'AR_MODE') return;
        if (modeCfgRef.current.energyEnabled && energyRef.current <= 0) return;

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

            /* Update sample indicator arrow. */
            const arrowEl = document.getElementById('sample-arrow') as any;
            if (arrowEl) {
                const currentSamples = samplesRef.current;
                if (currentSamples.length === 0) {
                    arrowEl.setAttribute('visible', 'false');
                } else {
                    const rx2 = result.position[0], ry2 = result.position[1], rz2 = result.position[2];
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
                        // Orbit: place arrow at fixed radius around rover in the sample's direction
                        const ORBIT_RADIUS = 0.20;
                        const arrowPos = roverVec.clone()
                            .addScaledVector(projected, ORBIT_RADIUS)
                            .addScaledVector(normal, 0.04);
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
                const drained = Math.max(0, energyRef.current - modeCfgRef.current.energyDrainPerSec * (MOVE_INTERVAL / 1000));
                energyRef.current = drained;
                setEnergy(drained);
            }

            /* Check sample collection within radius. */
            const COLLECTION_RADIUS = 0.25;
            const rx = result.position[0], ry = result.position[1], rz = result.position[2];
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
                const popup = popups[popupIndex];
                setWaypointPopup(popup);
                popupIndex = popupIndex + 1;

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

    /** On game start: reset state and spawn samples/obstacles (WEB_GAME only). */
    useEffect(() => {
        if (gameState === 'WEB_GAME' || gameState === 'AR_MODE') {
            setRoverReady(false);
            setScore(0);
            prevCamUp.current = null;
            if (meshLoaded && gameState === 'WEB_GAME') {
                // Samples — randomly placed on the asteroid surface; retry on raycast miss
                const sampleList: { id: string; x: number; y: number; z: number }[] = [];
                const MAX_ATTEMPTS = modeCfg.spawnSamples * 10;
                let attempts = 0;
                while (sampleList.length < modeCfg.spawnSamples && attempts < MAX_ATTEMPTS) {
                    attempts++;
                    const dir = randomUnitVector();
                    try {
                        const r = get_surface_point_in_direction(dir[0], dir[1], dir[2]);
                        sampleList.push({ id: `s-${sampleList.length}`, x: r.position[0], y: r.position[1], z: r.position[2] });
                    } catch (_) { }
                }
                setSamples(sampleList);
                const arrowElStart = document.getElementById('sample-arrow') as any;
                if (arrowElStart) arrowElStart.setAttribute('visible', 'true');

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

                energyRef.current = 100;
                setEnergy(100);
            } else {
                setSamples([]);
                setObstacles([]);
                const arrowElStop = document.getElementById('sample-arrow') as any;
                if (arrowElStop) arrowElStop.setAttribute('visible', 'false');
            }
        }
    }, [gameState, meshLoaded]);

    /** Trigger end screen when all samples collected or energy depleted. */
    useEffect(() => {
        if (gameState !== 'WEB_GAME' || showEndScreen) return;
        if (samplesCollected >= modeCfg.spawnSamples) {
            setEndReason('complete');
            setShowEndScreen(true);
        } else if (modeCfg.energyEnabled && energy <= 0) {
            setEndReason('energy');
            setShowEndScreen(true);
        }
    }, [samplesCollected, energy, gameState, showEndScreen]);

    /** Keyboard listeners and rover init: snap to surface before revealing scene. */
    useEffect(() => {
        if ((gameState !== 'WEB_GAME' && gameState !== 'AR_MODE') || !meshLoaded) {
            return () => { };
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
                arTarget.addEventListener('targetFound', () => {
                    console.log("AR Marker found!");
                    setScanPrompt(false);
                });
                arTarget.addEventListener('targetLost', () => {
                    console.log("AR Marker lost");
                    setScanPrompt(true);
                });
            }
        }
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
                        <button id="credits-button" ref={creditsBtnRef} onClick={() => setShowCredits(true)}>Credits</button>
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
                                <button ref={diffBtnRefs[0]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart('web_game', 'easy'); }}>Easy</button>
                                <button ref={diffBtnRefs[1]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart('web_game', 'normal'); }}>Normal</button>
                                <button ref={diffBtnRefs[2]} className="difficulty-btn" onClick={() => { setShowDifficulty(false); handleStart('web_game', 'hard'); }}>Hard</button>
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
                    {/* AR Scene with Camera Access */}
                    <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}>
                        <a-scene
                            mindar-image="imageTargetSrc: https://cdn.jsdelivr.net/gh/hiukim/mind-ar-js@1.2.5/examples/image-tracking/assets/card-example/card.mind;"
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
                                        scale="0.5 0.5 0.5"
                                        position="0 0 0"
                                    ></a-gltf-model>
                                </a-entity>

                                {/* Rover on asteroid */}
                                <a-entity id="rover" position="0 0.3 0" rotation="0 0 0">
                                    <a-gltf-model
                                        src="./models/craft_racer.glb"
                                        scale="0.05 0.05 0.05"
                                    ></a-gltf-model>
                                </a-entity>
                            </a-entity>
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
                            {modeCfg.energyEnabled && <div className="energy-display">ENERGY <div className="energy-bar"><div style={{ width: `${energy}%` }} /></div></div>}
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
                            {modeCfg.energyEnabled && <div className="energy-display">ENERGY <div className="energy-bar"><div style={{ width: `${energy}%` }} /></div></div>}
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
