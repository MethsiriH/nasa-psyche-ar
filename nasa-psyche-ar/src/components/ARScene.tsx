
import React from 'react';
import { SceneConfig, getArJsConfig } from '../ar-config';

interface ARSceneProps {
    children: React.ReactNode;
    config?: SceneConfig;
    onMarkerFound?: () => void;
    onMarkerLost?: () => void;
}

const ARScene: React.FC<ARSceneProps> = ({ children, config, onMarkerFound, onMarkerLost }) => {
    const sceneConfig = config || { markerType: 'barcode', markerValue: 0, matrixCodeType: '4x4', detectionMode: 'mono_and_matrix' };
    const arJsString = getArJsConfig(sceneConfig);

    React.useEffect(() => {
        const marker = document.querySelector('a-marker');
        if (marker) {
            marker.addEventListener('markerFound', () => {
                if (onMarkerFound) onMarkerFound();
            });
            marker.addEventListener('markerLost', () => {
                if (onMarkerLost) onMarkerLost();
            });
        }
    }, [onMarkerFound, onMarkerLost]);


    return (
        <a-scene
            embedded
            arjs={arJsString}
            renderer="logarithmicDepthBuffer: true;"
            vr-mode-ui="enabled: false"
        >
            {/* 
                // @ts-ignore */}
            <a-marker type={sceneConfig.markerType} value={sceneConfig.markerValue}>
                {children}
            </a-marker>
            <a-entity camera></a-entity>
        </a-scene>
    );
};

export default ARScene;
