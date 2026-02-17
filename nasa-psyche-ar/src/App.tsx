import { useEffect, useState } from 'react';
// @ts-ignore
import init, { start_ar_session } from '../rust_engine/pkg/rust_engine';

const App = () => {
    const [gameState, setGameState] = useState('MENU'); // MENU, WEB_GAME, AR_MODE
    const [score, setScore] = useState(0);
    const [scanPrompt, setScanPrompt] = useState(true);

    // Initialize Rust WASM on mount
    useEffect(() => {
        init().catch(console.error);
    }, []);

    const handleStart = async (mode: string) => {
        if (mode === 'web_game') {
            console.log("Starting WEB GAME MODE");
            setGameState('WEB_GAME');
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

    // TODO (Logic Team): Replace this with WASM mesh collision detection
    // Function should call Rust: update_rover_position_wasm(direction)
    // Expected return: { position: {x, y, z}, rotation: {x, y, z} }
    const moveRover = (direction: string) => {
        if (gameState !== 'WEB_GAME' && gameState !== 'AR_MODE') return;

        const rover = document.getElementById('rover') as any; // Using direct DOM for A-Frame speed
        if (!rover) return;

        const currentPos = rover.getAttribute('position');
        const speed = 0.08;

        switch (direction) {
            case 'forward':
                currentPos.z -= speed;
                break;
            case 'backward':
                currentPos.z += speed;
                break;
            case 'left':
                currentPos.x -= speed;
                break;
            case 'right':
                currentPos.x += speed;
                break;
        }

        // Temporary simple movement - Logic Team will replace with mesh collision
        rover.setAttribute('position', currentPos);
    };

    // Setup event listeners for AR target tracking
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
                        {/* Glowing orbs - Modern aesthetic */}
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
                        <button id="play-button" onClick={() => handleStart('web_game')}>
                            Launch Mission
                        </button>
                        <button id="start-button" onClick={() => handleStart('ar')}>AR Experience</button>
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

                        <div id="controls">
                            <div className="dpad-container">
                                <div className="dpad-center"></div>
                                <button className="control-btn dpad-up" onClick={() => moveRover('forward')}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M12 8L8 12H11V16H13V12H16L12 8Z" fill="currentColor"/>
                                    </svg>
                                </button>
                                <button className="control-btn dpad-down" onClick={() => moveRover('backward')}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M12 16L16 12H13V8H11V12H8L12 16Z" fill="currentColor"/>
                                    </svg>
                                </button>
                                <button className="control-btn dpad-left" onClick={() => moveRover('left')}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M8 12L12 8V11H16V13H12V16L8 12Z" fill="currentColor"/>
                                    </svg>
                                </button>
                                <button className="control-btn dpad-right" onClick={() => moveRover('right')}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M16 12L12 16V13H8V11H12V8L16 12Z" fill="currentColor"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                </>
            )}

            {gameState === 'WEB_GAME' && (
                <>
                    {/* Web Game Scene - Asteroid & Rover */}
                    <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}>
                        <a-scene
                            embedded
                            vr-mode-ui="enabled: false"
                            background="color: #000011"
                        >
                            {/* Camera - Centered directly on origin */}
                            <a-entity id="camera-rig" position="0 0 3.5">
                                <a-camera 
                                    position="0 0 0"
                                    look-controls="enabled: false" 
                                    wasd-controls="enabled: false"
                                ></a-camera>
                            </a-entity>

                            {/* Lighting */}
                            <a-light type="ambient" color="#FFFFFF" intensity="0.7"></a-light>
                            <a-light type="directional" color="#FFFFFF" intensity="1.2" position="4 6 5"></a-light>
                            <a-light type="point" color="#FFFFFF" intensity="0.5" position="-3 2 4"></a-light>

                            {/* Space background - stars at edges */}
                            <a-entity position="0 0 0">
                                <a-sphere position="6 4 -10" radius="0.08" color="#FFFFFF"></a-sphere>
                                <a-sphere position="-7 5 -12" radius="0.06" color="#FFFFFF"></a-sphere>
                                <a-sphere position="8 -3 -11" radius="0.07" color="#FFFFFF"></a-sphere>
                                <a-sphere position="-6 -4 -9" radius="0.05" color="#FFFFFF"></a-sphere>
                                <a-sphere position="5 6 -13" radius="0.06" color="#FFFFFF"></a-sphere>
                                <a-sphere position="-8 2 -14" radius="0.08" color="#FFFFFF"></a-sphere>
                                <a-sphere position="7 -5 -10" radius="0.05" color="#FFFFFF"></a-sphere>
                                <a-sphere position="-5 6 -11" radius="0.07" color="#FFFFFF"></a-sphere>
                            </a-entity>

                            {/* Asteroid - 3D Model (collision will be handled by Logic Team in Rust) */}
                            <a-entity 
                                id="asteroid" 
                                position="-2 -2.3 2.5" 
                                rotation="0 25 0"
                            >
                                <a-gltf-model 
                                    src="./models/AsteroidPsyche.glb" 
                                    scale="2.5 2.5 2.5"
                                ></a-gltf-model>
                            </a-entity>

                            {/* Rover - 3D Model positioned on asteroid surface */}
                            <a-entity 
                                id="rover" 
                                position="-0.5 0 0.8" 
                                rotation="0 0 0"
                            >
                                <a-gltf-model 
                                    src="./models/craft_racer.glb" 
                                    scale="0.2 0.2 0.2"
                                ></a-gltf-model>
                            </a-entity>
                        </a-scene>
                    </div>

                    <div id="ui-overlay" style={{ display: 'block' }}>
                        <div id="score-display">
                            SCORE <span id="score">{score}</span>
                        </div>

                        <div id="controls">
                            <div className="dpad-container">
                                <div className="dpad-center"></div>
                                <button className="control-btn dpad-up" onClick={() => moveRover('forward')}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M12 8L8 12H11V16H13V12H16L12 8Z" fill="currentColor"/>
                                    </svg>
                                </button>
                                <button className="control-btn dpad-down" onClick={() => moveRover('backward')}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M12 16L16 12H13V8H11V12H8L12 16Z" fill="currentColor"/>
                                    </svg>
                                </button>
                                <button className="control-btn dpad-left" onClick={() => moveRover('left')}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M8 12L12 8V11H16V13H12V16L8 12Z" fill="currentColor"/>
                                    </svg>
                                </button>
                                <button className="control-btn dpad-right" onClick={() => moveRover('right')}>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                                        <path d="M16 12L12 16V13H8V11H12V8L16 12Z" fill="currentColor"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default App;
