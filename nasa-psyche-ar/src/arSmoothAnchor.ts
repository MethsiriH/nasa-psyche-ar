/**
 * Reduces AR.js marker jitter by lerping world transform from the tracked marker
 * onto a sibling entity (content should live here, not under <a-marker>).
 */
function registerArSmoothAnchor(): void {
    const AFRAME = (window as unknown as { AFRAME?: any }).AFRAME;
    if (!AFRAME?.registerComponent) return;
    if (AFRAME.components['ar-smooth-anchor']) return;

    AFRAME.registerComponent('ar-smooth-anchor', {
        schema: {
            target: { type: 'selector' },
            positionLerp: { default: 0.16 },
            rotationLerp: { default: 0.2 },
            scaleLerp: { default: 0.18 },
            /** If raw pose jumps farther than this (world units), extra damping is applied (reduces tracker pops). */
            maxJump: { default: 0.2 },
        },
        init(this: any) {
            const THREE = AFRAME.THREE;
            this._pos = new THREE.Vector3();
            this._quat = new THREE.Quaternion();
            this._scale = new THREE.Vector3();
            this._rawPos = new THREE.Vector3();
            this._rawQuat = new THREE.Quaternion();
            this._rawScale = new THREE.Vector3();
            this._prevRawPos = new THREE.Vector3();
            this._prevRawQuat = new THREE.Quaternion();
            this._hasPrevRaw = false;
            this._initialized = false;
        },
        tick(this: any) {
            const el = this.data.target as { object3D?: any } | null;
            if (!el?.object3D) return;
            const src = el.object3D;
            if (!src.visible) {
                this.el.object3D.visible = false;
                this._initialized = false;
                this._hasPrevRaw = false;
                return;
            }
            this.el.object3D.visible = true;
            src.updateMatrixWorld(true);
            const mat = src.matrixWorld;
            mat.decompose(this._rawPos, this._rawQuat, this._rawScale);

            let pl = this.data.positionLerp;
            let rl = this.data.rotationLerp;
            const sl = this.data.scaleLerp;
            const maxJ = this.data.maxJump;

            if (this._hasPrevRaw && this._initialized && maxJ > 0) {
                const d = this._rawPos.distanceTo(this._prevRawPos);
                if (d > maxJ) {
                    pl = Math.min(pl, 0.032);
                    rl = Math.min(rl, 0.04);
                }
                const dot = Math.min(1, Math.abs(this._prevRawQuat.dot(this._rawQuat)));
                const ang = 2 * Math.acos(dot);
                if (ang > 0.35) {
                    rl = Math.min(rl, 0.045);
                }
            }
            this._prevRawPos.copy(this._rawPos);
            this._prevRawQuat.copy(this._rawQuat);
            this._hasPrevRaw = true;

            if (!this._initialized) {
                this._pos.copy(this._rawPos);
                this._quat.copy(this._rawQuat);
                this._scale.copy(this._rawScale);
                this._initialized = true;
            } else {
                this._pos.lerp(this._rawPos, pl);
                this._quat.slerp(this._rawQuat, rl);
                this._scale.lerp(this._rawScale, sl);
            }

            this.el.object3D.position.copy(this._pos);
            this.el.object3D.quaternion.copy(this._quat);
            this.el.object3D.scale.copy(this._scale);
        },
    });
}

registerArSmoothAnchor();
