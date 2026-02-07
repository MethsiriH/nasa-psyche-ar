
export interface SceneConfig {
    markerType: 'pattern' | 'barcode';
    markerValue: string | number; // 'hiro' for pattern, number for barcode
    matrixCodeType?: string; // e.g., '3x3'
    detectionMode?: 'mono' | 'mono_and_matrix' | 'color' | 'color_and_matrix';
    cameraParametersUrl?: string;
}

export const defaultSceneConfig: SceneConfig = {
    markerType: 'barcode',
    markerValue: 0,
    matrixCodeType: '4x4',
    detectionMode: 'mono_and_matrix'
};

export const getArJsConfig = (config: SceneConfig = defaultSceneConfig) => {
    return `sourceType: webcam; sourceWidth:1280; sourceHeight:960; displayWidth: 1280; displayHeight: 960; debugUIEnabled: false; detectionMode: ${config.detectionMode}; matrixCodeType: ${config.matrixCodeType};`;
};
